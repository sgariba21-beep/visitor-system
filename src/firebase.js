import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

// Paste YOUR config from Firebase console here
const firebaseConfig = {
  apiKey: "AIzaSyB6iQyE0jPrOLarAaMlibERF8nTvLpPY3c",
  authDomain: "school-visitor-system-2da08.firebaseapp.com",
  projectId: "school-visitor-system-2da08",
  storageBucket: "school-visitor-system-2da08.firebasestorage.app",
  messagingSenderId: "626492335224",
  appId: "1:626492335224:web:35757c5073cafa7ad6398d"
};

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);
export const auth = getAuth(app);