import { useState } from 'react';
import { supabase } from './supabaseClient';

export default function Login({ onLogin}) {
    const [email, setEmail] = useState('');

    const handleLogin = async () => {
        const { error } = await supabase.auth.signInWithOtp({ email });

        if (error) {
            alert("Login error: " + error.message);
        } else {
            alert("Check your email for the login link!");
            //Supabase will redirect, we can handle session in App.js
        }
    };
    return (
        <div>
            <h2>Login</h2>
            <input
                type="email"
                placeholder="your email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
            />
            <button onClick={handleLogin}>Send Magic Link</button>
        </div>
        );
    }