import { pilotOrigin } from "../../../shared/pilot";
import { protectedCallMessage } from "../../../shared/result";
import { useCallback, useState } from "react";
import { useFocusEffect } from "expo-router";
import { ScrollView, Text } from "react-native";
import { stampOf, useDatabase, useWorkspace } from "../../../composition/database";
import { gateProtectedCall, sameWorkspace } from "../../../modules/accountSession";
import { courseBaseUrl, grantChatConsent, hasChatConsent, setCourseBaseUrl } from "../../../modules/chat";
import { aiRevocationPending, fetchAiPolicy, grantAnalyticsConsent, hasAnalyticsConsent, readAiPolicy, revokeAnalyticsConsent, revokeAiLocally, updateAiConsent, type AiPolicy } from "../../../modules/aiConsent";
import { readSyncState } from "../../../modules/syncStore";
import { Muted, NavBar, PageHeading, Screen, screenPadding } from "../../../ui/chrome";
import { FieldLabel, PrimaryButton, TextField } from "../../../ui/fields";
import { usePalette } from "../../../ui/theme";

export default function ConnectionScreen() {
 const palette=usePalette();const db=useDatabase();const workspace=useWorkspace();
 const [allowed,setAllowed]=useState(()=>hasChatConsent(db));
 const [analytics,setAnalytics]=useState(()=>hasAnalyticsConsent(db));
 const [baseUrl,setBaseUrl]=useState(()=>courseBaseUrl(db));
 const [policy,setPolicy]=useState<AiPolicy|null>(()=>readAiPolicy(db,courseBaseUrl(db)));
 const [pending,setPending]=useState(()=>aiRevocationPending(db,courseBaseUrl(db)));
 const [message,setMessage]=useState<string|null>(null);
 const [busy,setBusy]=useState(false);
 const refresh=useCallback(async()=>{
   const sent=workspace.capture();const base=courseBaseUrl(sent.db);
   const gate=gateProtectedCall({access:sent.access,sent:stampOf(sent),active:stampOf(sent),consent:true,now:new Date().toISOString(),targetServer:base});
   if(gate.action==='stop'){setMessage(protectedCallMessage(gate.code));return;}
   const boundOrigin=sent.access.mode==='signed-in'?sent.access.serverOrigin??readSyncState(sent.db).origin:null;
   const result=await fetchAiPolicy({db:sent.db,baseUrl:base,authorization:gate.authorization,boundOrigin,isCurrent:()=>sameWorkspace(stampOf(sent),stampOf(workspace.capture()))});
   if(!sameWorkspace(stampOf(sent),stampOf(workspace.capture())))return;
   setPolicy(result.ok||aiRevocationPending(sent.db,base)?readAiPolicy(sent.db,base):null);setPending(aiRevocationPending(sent.db,base));
   setMessage(result.ok?null:protectedCallMessage(result.code));
 },[workspace]);
 useFocusEffect(useCallback(()=>{void refresh();},[refresh]));
 async function change(accepted:boolean){
   if(!policy||busy)return;
   const sent=workspace.capture();const base=courseBaseUrl(sent.db);const selected=policy;
   if(!accepted){revokeAiLocally(sent.db,base,selected);setPolicy({...selected,accepted:false});setPending(true);setMessage('AI is off on this phone. Confirming revocation with the server.');}
   const gate=gateProtectedCall({access:sent.access,sent:stampOf(sent),active:stampOf(sent),consent:true,now:new Date().toISOString(),targetServer:base});
   if(gate.action==='stop'){setMessage(`${accepted?'Permission was not confirmed.':'AI remains off on this phone.'} ${protectedCallMessage(gate.code)}`);return;}
   setBusy(true);
   try {
     const boundOrigin=sent.access.mode==='signed-in'?sent.access.serverOrigin??readSyncState(sent.db).origin:null;
     const result=await updateAiConsent({db:sent.db,baseUrl:base,authorization:gate.authorization,boundOrigin,policy:selected,accepted,isCurrent:()=>sameWorkspace(stampOf(sent),stampOf(workspace.capture()))});
     if(!sameWorkspace(stampOf(sent),stampOf(workspace.capture())))return;
     setPolicy(readAiPolicy(sent.db,base));setPending(aiRevocationPending(sent.db,base));
     setMessage(result.ok?(accepted?'AI sharing allowed for this provider.':'AI sharing revoked on the server.'):`${accepted?'Permission was not confirmed.':'AI remains off locally. Server revocation is unconfirmed.'} ${protectedCallMessage(result.code)}`);
   }finally{if(sameWorkspace(stampOf(sent),stampOf(workspace.capture())))setBusy(false);}
 }
 function save(){try{setCourseBaseUrl(db,baseUrl);setBaseUrl(courseBaseUrl(db));setPolicy(null);setMessage('Server address saved. Refresh provider information before allowing AI.');}catch{setMessage('Enter a valid HTTPS server address. Development loopback HTTP is also supported.');}}
 return <Screen><NavBar title="Chat & analysis"/><ScrollView style={{flex:1}} contentContainerStyle={screenPadding} keyboardShouldPersistTaps="handled">
  <PageHeading eyebrow="Permissions and connection" title="Chat & analysis"/>
  <Text style={{color:palette.text,lineHeight:23}}>Sending a chat note shares the note, active workout ID and name, context revision, and the entire exercise catalog (IDs, names, types) with your server and, when enabled, the named AI provider. Notes may contain sensitive information. Coaching also shares your training profile, bounded completed workout history and calculated facts, gaps, your check-in and question, and up to four recent conversation turns. Coaching is read-only; it never logs sets or saves plans. Conversations stay in memory on this phone and clear when you leave Coach or your account or context changes.</Text>
  <Text style={{color:palette.text,marginTop:18}}>{allowed?'Sending to your server is allowed.':'Sending to your server is off.'}</Text>
  {!allowed?<PrimaryButton label="Allow sending to server" onPress={()=>{grantChatConsent(db);setAllowed(true);}}/>:null}
  <Text style={{color:palette.text,marginTop:18}}>{policy?`AI provider: ${policy.providerName}`:'AI provider information unavailable.'}</Text>
  {policy?<><Muted>{policy.external?'This provider receives the data described above.':'This server uses a local parser without an external AI provider.'}</Muted><Muted>{policy.retentionNotice}</Muted><Muted>Declared fields: {policy.fields.join(', ')}</Muted>{<><Text style={{color:palette.text}}>{policy.accepted?'AI sharing is allowed.':'AI sharing is off.'}</Text>{!policy.accepted&&!pending?<PrimaryButton label={`Allow AI sharing with ${policy.providerName}`} disabled={busy} onPress={()=>void change(true)}/>:null}<PrimaryButton label={pending?'Retry server revocation':'Revoke AI permission'} disabled={busy} onPress={()=>void change(false)}/></>}</>:null}
  {pending?<Muted>AI is blocked locally. Server revocation still needs confirmation.</Muted>:null}
  <PrimaryButton label="Refresh provider information" disabled={busy} onPress={()=>void refresh()}/>
  <Text style={{color:palette.text,marginTop:18}}>Progress analysis sends workouts in your selected dates to your server. This permission is separate from AI and cloud sync.</Text>
  <PrimaryButton label={analytics?'Revoke progress analysis':'Allow progress analysis'} onPress={()=>{if(analytics)revokeAnalyticsConsent(db);else grantAnalyticsConsent(db);setAnalytics(!analytics);}}/>
  <FieldLabel>Server address</FieldLabel>{pilotOrigin ? <Muted>{pilotOrigin}</Muted> : <><TextField label="Server address" value={baseUrl} onChangeText={setBaseUrl} keyboard="url" placeholder="https://your-server.example"/>
  <PrimaryButton label="Save server address" onPress={save}/></>}
  <Muted size={12}>Manual workout logging works without this connection.</Muted>
  {message?<Text style={{color:palette.primary,marginTop:14}}>{message}</Text>:null}
 </ScrollView></Screen>;
}
