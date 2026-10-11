const {join}=require('node:path');
const {readFile}=require('node:fs/promises');
const {pathToFileURL}=require('node:url');
const {randomBytes}=require('node:crypto');
const {createJiti}=require('jiti');
const PROVIDER_ID='antigravity-gemini-subscription';
const PORT=51124;
const isProviderId = value => value === PROVIDER_ID || /^antigravity-gemini-subscription-\d+$/.test(value);
let runtimePromise;
async function loadSdk(){
 const jiti=createJiti(__filename,{moduleCache:true,tryNative:false,fsCache:false,alias:{
  '@earendil-works/pi-ai':join(__dirname,'node_modules/desktop-provider-ai/dist/index.js'),
 }});
 const oauth=await jiti.import(join(__dirname,'vendor/antigravity/auth/oauth.ts'));
 const discovery=await jiti.import(join(__dirname,'vendor/antigravity/models/discovery.ts'));
 const streaming=await jiti.import(join(__dirname,'vendor/antigravity/stream/stream.ts'));
 discovery.hydrateAntigravityCatalog('antigravity',require('./gemini-catalog-state.json'));
 return {...oauth,...streaming};
}
async function loadSecret(){
 const {dataDir,dpapi,atomicWrite,withFileLock}=await import(pathToFileURL(join(__dirname,'store.mjs')));
 const file=join(dataDir,'antigravity-gateway-key.dpapi');
 return withFileLock(file,async()=>{
  try{const key=await dpapi(await readFile(file),true);if(key.length!==32)throw new Error('Invalid gateway key');return key;}
  catch(error){if(error.code!=='ENOENT')throw new Error('Gateway signing key unavailable');}
  const key=randomBytes(32);await atomicWrite(file,await dpapi(key));return key;
 });
}
async function createRuntime({sdk,secret,port=PORT,gatewayFactory}={}){
 const api=sdk??await loadSdk();
 const key=secret??await loadSecret();
 const factory=gatewayFactory??require('./antigravity-gateway.cjs').createGateway;
 const {dataDir}=await import(pathToFileURL(join(__dirname,'store.mjs')));
 const {createToolSignatureStore}=await import(pathToFileURL(join(__dirname,'tool-signatures.mjs')));
 const signatureStore=createToolSignatureStore({secret:key,file:join(dataDir,'tool-signatures.enc')});
 const gateway=factory({secret:key,models:require('./gemini-models.json'),stream:api.streamAntigravity,signatureStore});
 await gateway.start(port);
 return {api,gateway};
}
function runtime(){return runtimePromise ||= createRuntime().catch(error=>{runtimePromise=undefined;const detail=error?.code??error?.message??error;throw new Error(`Antigravity local gateway could not start: ${detail}`,{cause:error});});}
async function onLoad(){await runtime();}
async function onUnload(){const pending=runtimePromise;runtimePromise=undefined;if(pending){const state=await pending.catch(()=>undefined);await state?.gateway.close();}}
function encode(credential,gateway){
 if(typeof credential.access!=='string'||!credential.access||typeof credential.refresh!=='string'||!credential.refresh||typeof credential.projectId!=='string'||!credential.projectId||!Number.isSafeInteger(credential.expires))throw new Error('Invalid Google credential');
 const refreshToken=JSON.stringify({version:1,refresh:credential.refresh,projectId:credential.projectId,email:credential.email});
 const accessToken=gateway.signCredential({token:credential.access,projectId:credential.projectId});
 if(Buffer.byteLength(refreshToken)>16384||Buffer.byteLength(accessToken)>16384)throw new Error('Credential exceeds Desktop limit');
 return {accessToken,refreshToken,expiresAt:credential.expires,accountLabel:String(credential.email||'Google Antigravity').slice(0,256)};
}
function decode(native){
 const metadata=JSON.parse(native.refreshToken);
 if(metadata.version!==1||typeof metadata.refresh!=='string'||!metadata.refresh||typeof metadata.projectId!=='string'||!metadata.projectId)throw new Error('Invalid Google refresh metadata');
 return {refresh:metadata.refresh,projectId:metadata.projectId,email:metadata.email,expires:native.expiresAt};
}
function createHandler(getRuntime=runtime){
 return async(input,{signal})=>{
  if(!isProviderId(input.providerId))throw new Error('Unsupported Antigravity subscription');
  signal?.throwIfAborted();
  const {api,gateway}=await getRuntime();
  signal?.throwIfAborted();
  if(input.operation==='refresh'){
   const refreshed=await api.refreshAntigravityToken(decode(input.credential),signal);
   // Return completed rotations to Desktop even when cancellation races success.
   return encode(refreshed,gateway);
  }
  if(input.operation!=='login')throw new Error('Unsupported Google OAuth operation');
  const controller=new AbortController();
  const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  let notice=Promise.resolve();
  try{
   const credential=await api.loginAntigravity({signal:combined,
    onAuth:({url,instructions})=>{
     notice=pi.providers.oauth.notify(input.loginId,{kind:'authUrl',url,instructions});
     notice.catch(()=>controller.abort(new DOMException('Authorization UI unavailable','AbortError')));
    },
    onProgress:()=>{},
   });
   await notice;combined.throwIfAborted();return encode(credential,gateway);
  }catch(error){if(combined.aborted)throw new DOMException('Google sign-in cancelled','AbortError');throw new Error('Google Antigravity sign-in failed');}
 };
}
// loadSecret is exported so the quota callback can verify the gateway's own signed
// envelope with the same machine key that produced it, instead of trusting it.
module.exports={PROVIDER_ID,PORT,isProviderId,onLoad,onUnload,onProviderOAuth:createHandler(),createHandler,createRuntime,encode,decode,loadSdk,loadSecret};
