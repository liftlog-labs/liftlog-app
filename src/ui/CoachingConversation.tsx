import { protectedCallMessage } from "../shared/result";
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { stampOf, useWorkspace } from '../composition/database';
import { gateProtectedCall, sameWorkspace } from '../modules/accountSession';
import { aiConsentRevision, canUseAiPolicy, fetchAiPolicy, readAiPolicy } from '../modules/aiConsent';
import { courseBaseUrl } from '../modules/chat';
import { requestCoaching, sameCoachingStamp, type CoachingResponse, type CoachingStamp, type CoachingTurn } from '../modules/coaching';
import { personalContextFromDatabase } from '../modules/personalContext';
import { readSyncState } from '../modules/syncStore';
import { usePalette } from './theme';

export function CoachingConversation(){
 const palette=usePalette();const workspace=useWorkspace();
 const [question,setQuestion]=useState('');const [turns,setTurns]=useState<CoachingTurn[]>([]);const [answer,setAnswer]=useState<CoachingResponse|null>(null);const [message,setMessage]=useState('');const [busy,setBusy]=useState(false);
 const mounted=useRef(true);const [conversationStamp,setConversationStamp]=useState<CoachingStamp|null>(null);const running=useRef(false);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 function capture():CoachingStamp|null {
  const s=workspace.capture();if(s.access.mode!=='signed-in'||!s.access.accountId)return null;
  const origin=courseBaseUrl(s.db);const policy=readAiPolicy(s.db,origin);const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;const state=readSyncState(s.db);
  if(state.terminal)return null;
  return {accountId:s.access.accountId,generation:s.generation,workspaceId:s.workspaceId,contextRevision:personalContextFromDatabase(s.db,new Date().toISOString(),zone).revision,cursor:state.cursor,consentEpoch:aiConsentRevision(s.db,origin),providerId:policy?.providerId??'',origin};
 }
 // Never render or resend a conversation belonging to a changed account, context, or permission.
 const active=capture();const stale=conversationStamp!==null&&(!active||!sameCoachingStamp(conversationStamp,active));
 if(stale){setTurns([]);setAnswer(null);setConversationStamp(null);setMessage('Your account, training context or permission changed. Ask again for a fresh answer.');}
 async function send(){
  const text=question.trim();if(!text||running.current)return;running.current=true;setBusy(true);setMessage('');
  let canReport=()=>mounted.current;
  try{
   const sent=workspace.capture();
   const alive=()=>mounted.current&&sameWorkspace(stampOf(sent),stampOf(workspace.capture()));
   canReport=alive;
   const base=courseBaseUrl(sent.db);const initial=capture();
   if(!initial||sent.access.mode!=='signed-in'){setMessage('Sign in to use coaching. Manual logging is available.');return;}
   const gate=gateProtectedCall({access:sent.access,sent:stampOf(sent),active:stampOf(workspace.capture()),consent:true,now:new Date().toISOString(),targetServer:base});
   if(gate.action==='stop'||!gate.authorization){setMessage(protectedCallMessage(gate.action==='stop'?gate.code:'SIGN_IN'));return;}
   const policy=await fetchAiPolicy({db:sent.db,baseUrl:base,authorization:gate.authorization,boundOrigin:sent.access.serverOrigin,isCurrent:alive});
   if(!alive())return;
   const stamp=capture();
   if(!stamp||initial.contextRevision!==stamp.contextRevision||initial.cursor!==stamp.cursor||initial.consentEpoch!==stamp.consentEpoch){setMessage('Your context changed. Try again for a fresh answer.');return;}
   if(!policy.ok){setMessage(protectedCallMessage(policy.code));return;}
   if(!canUseAiPolicy(sent.db,base,policy.value)){setMessage('Review and allow the current coaching provider permission in Connection settings.');return;}
   const state=readSyncState(sent.db);
   const recent=conversationStamp&&sameCoachingStamp(conversationStamp,stamp)?turns.slice(-4):[];
   const result=await requestCoaching({baseUrl:base,authorization:gate.authorization,boundOrigin:sent.access.serverOrigin,question:text,aiPolicyId:policy.value.providerId,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,sync:{cursor:state.cursor,pending:!!sent.db.get('SELECT seq FROM sync_outbox LIMIT 1'),conflicts:!!sent.db.get('SELECT id FROM sync_conflict WHERE resolved=0 LIMIT 1')},turns:recent,stamp,current:()=>alive()?capture():null,canUse:()=>alive()&&canUseAiPolicy(sent.db,base,policy.value)});
   if(!alive())return;
   if(!result.ok){setMessage(protectedCallMessage(result.code));return;}
   setConversationStamp(stamp);setAnswer(result.value);setTurns([...recent,{role:'user',text},{role:'assistant',text:result.value.answer.slice(0,1500)}].slice(-4) as CoachingTurn[]);setQuestion('');
  }catch{
   // A local storage failure is recoverable and must not discard the question.
   if(canReport())setMessage('Coaching is unavailable. Your question is kept; try again.');
  }finally{running.current=false;if(mounted.current)setBusy(false);}
 }
 const visible=stale?null:answer;
 return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{padding:24,gap:16,paddingBottom:48}}>
  <Text style={{color:palette.text,fontSize:28,fontWeight:'700'}}>Your training coach</Text>
  <Text style={{color:palette.muted,lineHeight:22}}>Ask what to train today or follow up. Include your available time, energy, soreness or pain. Missing logs do not prove rest or recovery.</Text>
  <Text style={{color:palette.muted,lineHeight:22}}>Your server and named provider receive your question/check-in, training profile, bounded completed history and facts, and up to four recent turns. Conversation stays in memory here. These are suggestions you can adjust. Advice does not save a plan or log performed sets.</Text>
  {visible?<View style={{padding:18,gap:14,backgroundColor:palette.soft,borderRadius:16}}>
   <Text style={{color:palette.primary,fontWeight:'700'}}>COACHING SUGGESTION · {visible.focus.replace('_',' ')}</Text>
   <Text selectable style={{color:palette.text,lineHeight:24}}>{visible.answer}</Text>
   <Text style={{color:palette.muted}}>Based on synced records as of {visible.snapshot.asOf} ({visible.snapshot.timeZone}).</Text>
   {visible.evidence.length?<Text style={{color:palette.text,fontWeight:'600'}}>Records used</Text>:null}
   {visible.evidence.map(e=><Text selectable key={e.id} style={{color:palette.text,lineHeight:22}}>{e.text}</Text>)}
   {visible.uncertainties.map((t,i)=><Text key={`u${i}`} style={{color:palette.muted,lineHeight:22}}>Uncertain: {t}</Text>)}
   {visible.questions.map((t,i)=><Text key={`q${i}`} style={{color:palette.text,lineHeight:22}}>{t}</Text>)}
  </View>:null}
  <TextInput accessibilityLabel="Coaching question and check-in" placeholder="What should I train today?" placeholderTextColor={palette.muted} value={question} onChangeText={setQuestion} maxLength={1000} multiline editable={!busy} style={{color:palette.text,borderColor:palette.line,borderWidth:1,borderRadius:12,padding:16,minHeight:110,textAlignVertical:'top'}}/>
  {busy?<ActivityIndicator accessibilityLabel="Asking coach" color={palette.primary}/>:null}
  <Pressable accessibilityRole="button" disabled={busy||!question.trim()} onPress={()=>void send()} style={{backgroundColor:palette.primary,padding:16,borderRadius:12,opacity:busy||!question.trim()?0.5:1}}><Text style={{color:palette.onPrimary,textAlign:'center',fontWeight:'600'}}>{busy?'Asking…':message?'Try again':'Ask coach'}</Text></Pressable>
  {message?<Text accessibilityRole="alert" style={{color:palette.text,lineHeight:22}}>{message}</Text>:null}
  <Pressable accessibilityRole="button" onPress={()=>router.push('/connection')}><Text style={{color:palette.primary,paddingVertical:10}}>Connection and AI permission</Text></Pressable>
  <Pressable accessibilityRole="button" onPress={()=>router.push('/(tabs)/(home)')}><Text style={{color:palette.primary,paddingVertical:10}}>Open manual workout logging</Text></Pressable>
 </ScrollView>;
}
