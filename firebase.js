/* ============================================================
   Prince Alex TicketHub - shared Firebase setup
   Powered by Prince Alex Digital

   This is the ONE place where the Firebase web configuration
   lives. Every page loads it BEFORE its inline script:

       <script src="firebase.js"></script>

   and reads the shared values through:

       window.PAT_FIREBASE_CONFIG   (project configuration)
       window.PAT_FIREBASE_SDK      (Firebase JS SDK CDN base)
       window.Auth                  (shared authentication helper)

   SECURITY NOTE
   -------------
   The Firebase web config below is PUBLIC BY DESIGN: it only
   identifies the project to the Firebase client SDK and is safe
   to ship in frontend code. Actual access control is enforced by:
     - Firebase Authentication and authorized domains
     - the Cloudflare Worker validating every Firebase ID token
     - D1 role/permission checks inside the Worker

   NEVER place any of the following in this (or any frontend) file:
     - Firebase Admin / service-account credentials
     - Paystack or Pesapal secret keys
     - Cloudflare R2 keys or API tokens
   Those live only in Cloudflare Worker environment secrets.
   ============================================================ */

var PAT_FIREBASE_CONFIG = {
  apiKey: "AIzaSyAz4whUZDUFOomthEACZvpTXb65I7K5Zck",
  authDomain: "prince-alex-tickethub.firebaseapp.com",
  projectId: "prince-alex-tickethub",
  storageBucket: "prince-alex-tickethub.firebasestorage.app",
  messagingSenderId: "425639716620",
  appId: "1:425639716620:web:2aba1a92810311e1bbcb29"
};

/* Firebase JS SDK base URL - loaded on demand by the Auth helper below,
   no build step required. Keep the version in one place: here. */
var PAT_FIREBASE_SDK = "https://www.gstatic.com/firebasejs/10.12.2/";

/* ------------------------------------------------------------
   Shared authentication helper.
   Same API every TicketHub page already uses:
     Auth.init()                  - load the SDK and initialize
     Auth.signIn(email, password) - returns the Firebase user
     Auth.signUp(email, password, fullName)
     Auth.sendReset(email)        - password reset email
     Auth.signOut()
     Auth.getIdToken()            - Firebase ID token for the Worker
     Auth.user                    - current user (null when signed out)
   Fires window event "auth:change" (detail.user) on sign-in/out.
   ------------------------------------------------------------ */
var Auth = {
  _auth: null, _promise: null, _ready: null, _mods: null, user: null,
  init(){
    if(this._promise) return this._promise;
    if(!/^https?:/i.test(PAT_FIREBASE_SDK)) throw new Error("bad sdk");
    this._promise = Promise.all([
      import(PAT_FIREBASE_SDK + "firebase-app.js"),
      import(PAT_FIREBASE_SDK + "firebase-auth.js")
    ]).then(mods => {
      const appMod = mods[0], authMod = mods[1];
      const app = (appMod.getApps && appMod.getApps().length) ? appMod.getApp() : appMod.initializeApp(PAT_FIREBASE_CONFIG);
      this._mods = authMod;
      this._auth = authMod.getAuth(app);
      authMod.onAuthStateChanged(this._auth, u => {
        this.user = u;
        window.dispatchEvent(new CustomEvent("auth:change", { detail: { user: u } }));
      });
      return this._auth;
    }).catch(err => { this._promise = null; throw err; });
    return this._promise;
  },
  /* Wait until Firebase has finished restoring the session for this page.
     auth.currentUser is null right after getAuth() until the persisted
     session has been read from IndexedDB - reading it too early (i.e. on
     any fresh page load) made getIdToken() return null, so protected pages
     bounced signed-in users back to the login form.
     Preference order:
       1. auth.authStateReady() - the SDK's own "the persisted session has
          been restored" promise (settles in milliseconds in practice).
       2. the first onAuthStateChanged event, which always fires once the
          initial auth state is known.
       3. a hard cap, so a page can never sit on a spinner because the auth
          state never reported in (blocked storage, broken SDK load, ...).
          getIdToken() still re-reads auth.currentUser on every call, so a
          session that shows up later is picked up by the next call. */
  ready(){
    if(!this._ready){
      this._ready = this.init().then(a => new Promise(resolve => {
        let settled = false, off = null, cap = null;
        const finish = () => {
          if(settled) return;
          settled = true;
          if(cap) clearTimeout(cap);
          if(off){ try { off(); } catch(err){} }
          resolve(a);
        };
        try {
          if(a && typeof a.authStateReady === "function"){
            a.authStateReady().then(finish, finish);
          } else {
            off = this._mods.onAuthStateChanged(a, finish);
          }
        } catch(err){ /* fall through to the cap below */ }
        cap = setTimeout(finish, 10000);
      })).catch(err => { this._ready = null; throw err; });
    }
    return this._ready;
  },
  async signIn(email, password){ const a = await this.init(); const c = await this._mods.signInWithEmailAndPassword(a, email, password); return c.user; },
  async signUp(email, password, fullName){
    const a = await this.init();
    const c = await this._mods.createUserWithEmailAndPassword(a, email, password);
    if(fullName){ try { await this._mods.updateProfile(c.user, { displayName: fullName }); } catch(e){} }
    return c.user;
  },
  async sendReset(email){
    const a = await this.init();
    /* Land the user back on the site's login page after the reset completes,
       instead of leaving them on Firebase's hosted action page. The origin
       comes from the page itself, so local/staging keep working. Firebase
       only honours the continue URL when the domain is in the project's
       Authorized domains - if it is not configured yet, fall back to the
       plain reset so the email still goes out. */
    let back = "";
    try { if(location && /^https?:$/i.test(location.protocol)) back = location.origin + "/login/"; } catch(e){ back = ""; }
    if(back){
      try {
        await this._mods.sendPasswordResetEmail(a, email, { url: back });
        return;
      } catch(e){
        const code = e && e.code;
        if(code !== "auth/unauthorized-domain" && code !== "auth/argument-error") throw e;
      }
    }
    await this._mods.sendPasswordResetEmail(a, email);
  },
  async signOut(){ if(!this._auth){ try { await this.init(); } catch(e){ return; } } if(this._auth) await this._mods.signOut(this._auth); },
  async getIdToken(){ try { await this.ready(); const u = this._auth && this._auth.currentUser; return u ? await u.getIdToken() : null; } catch(err){ return null; } }
};
window.Auth = Auth;