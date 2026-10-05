import { useEffect,useState } from 'react';
import { supabase } from './supabase';
export function useUserId(){
  const [id,setId]=useState<string|null>(null);
  useEffect(()=>{if(!supabase)return;const{data}=supabase.auth.onAuthStateChange((_event,session)=>setId(session?.user.id??null));return()=>data.subscription.unsubscribe();},[]);
  return id;
}
