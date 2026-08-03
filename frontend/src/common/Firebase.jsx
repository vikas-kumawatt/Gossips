
import { initializeApp } from "firebase/app";
import {getAuth, GoogleAuthProvider, signInWithPopup} from "firebase/auth"

const firebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID
  };

export const firebaseApp = initializeApp(firebaseConfig);

/**
 * Whether the project is actually configured.
 *
 * Google sign-in has always assumed it is, and the whole config comes from
 * `VITE_FIREBASE_*` — so on a deployment without them, `initializeApp` succeeds with
 * undefined values and every call fails later with an opaque error. Push registration
 * checks this instead of trying and logging a failure on every login.
 *
 * `messagingSenderId` and `appId` are the two Cloud Messaging needs.
 */
export const isFirebaseConfigured = Boolean(
  firebaseConfig.messagingSenderId && firebaseConfig.appId && firebaseConfig.projectId
);

// google auth

const provider = new GoogleAuthProvider();

const auth = getAuth();

export const authWithGoogle = async () => {
    
    let user = null;

    await signInWithPopup(auth, provider)
    .then((result) => {
       user = result.user
   
    } )
.catch((err) => {
    console.log(err)
})

    return user;
}