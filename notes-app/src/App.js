import { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';
import Login from './Login';
import Notes from './Notes';

function App() {
  const [session, setSession] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });

    const { 
      data: { subscription },
    } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setSession(session);
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  if (!session) {
    return <Login />;
  }
  
  return <Notes session={session} />;
}

export default App;

  