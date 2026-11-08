import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Link, Route, Routes, useNavigate } from "react-router-dom";
import { CitizenDashboard } from "./CitizenDashboard";
import { signIn, signOut, signUp, type AuthResult } from "./api";
import { AdminNoiseMetrics } from "./AdminNoiseMetrics";
import { NoiseMap } from "./NoiseMap";
import "./style.css";

const authStorageKey = "urbanpulse.auth";

function readAuth(): AuthResult | null {
  const saved = sessionStorage.getItem(authStorageKey);
  if (!saved) return null;
  try {
    return JSON.parse(saved) as AuthResult;
  } catch {
    sessionStorage.removeItem(authStorageKey);
    return null;
  }
}

function Home() {
  return (
    <main className="min-h-screen bg-[#f2f5ee] text-[#122e30]">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <Link to="/" className="text-xl font-bold tracking-tight">UrbanPulse<span className="text-[#e57b45]">.</span></Link>
        <nav className="flex items-center gap-6 text-sm font-medium">
          <Link to="/login" className="hover:text-[#e57b45]">Sign in</Link>
          <Link to="/register" className="rounded-full bg-[#123b3d] px-5 py-2.5 text-white hover:bg-[#205457]">Join the pilot</Link>
        </nav>
      </header>
      <section className="mx-auto grid max-w-6xl gap-10 px-6 pb-20 pt-16 md:grid-cols-[1.05fr_0.95fr] md:items-center md:pt-24">
        <div>
          <p className="mb-5 text-xs font-bold uppercase tracking-[0.2em] text-[#bc5930]">Dhaka · Community sensing</p>
          <h1 className="max-w-2xl text-5xl font-semibold leading-[1.08] tracking-tight md:text-7xl">A clearer picture of the city we share.</h1>
          <p className="mt-6 max-w-xl text-lg leading-8 text-[#496365]">UrbanPulse brings neighborhood sound and air-quality signals together to help Dhaka understand its changing environment.</p>
          <Link to="/register" className="mt-8 inline-flex rounded-full bg-[#d8663d] px-6 py-3 font-semibold text-white hover:bg-[#bb512c]">Take part in the pilot <span aria-hidden="true" className="ml-3">↗</span></Link>
        </div>
        <div className="landing-map"><NoiseMap /></div>
      </section>
      <footer className="mx-auto max-w-6xl px-6 pb-8">
        <p className="rounded-xl border border-[#d6dfd3] bg-white/70 px-4 py-3 text-sm text-[#496365]">
          Important: community readings are indicative estimates, not calibrated or official measurements. Air-quality information is informational only and is not medical advice.
        </p>
      </footer>
    </main>
  );
}

function AuthPage({ mode, onAuthenticated }: { mode: "login" | "register"; onAuthenticated: (result: AuthResult) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    const displayName = String(form.get("displayName") ?? "");
    setBusy(true);
    setError(null);
    try {
      const result = mode === "login"
        ? await signIn(email, password)
        : await signUp(email, password, displayName);
      onAuthenticated(result);
      navigate("/");
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : "Could not authenticate.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="grid min-h-screen place-items-center bg-[#f2f5ee] px-5 py-10 text-[#122e30]">
      <section className="w-full max-w-md rounded-[1.7rem] border border-[#d6dfd3] bg-white p-7 shadow-sm">
        <Link to="/" className="text-lg font-bold tracking-tight">UrbanPulse<span className="text-[#e57b45]">.</span></Link>
        <h1 className="mt-7 text-3xl font-semibold">{mode === "login" ? "Welcome back" : "Join the citizen pilot"}</h1>
        <p className="mt-2 text-sm leading-6 text-[#607779]">
          {mode === "login" ? "Sign in to record and manage your neighborhood reports." : "Create a citizen account to contribute indicative sound observations."}
        </p>
        <form className="mt-6 space-y-4" onSubmit={(event) => void handleSubmit(event)}>
          {mode === "register" && (
            <label className="block text-sm font-semibold">Display name
              <input name="displayName" required minLength={1} maxLength={80} autoComplete="name" className="form-input" />
            </label>
          )}
          <label className="block text-sm font-semibold">Email
            <input name="email" required type="email" maxLength={254} autoComplete="email" className="form-input" />
          </label>
          <label className="block text-sm font-semibold">Password
            <input name="password" required type="password" minLength={10} maxLength={128} autoComplete={mode === "login" ? "current-password" : "new-password"} className="form-input" />
            {mode === "register" && <span className="mt-1 block text-xs font-normal text-[#607779]">Use at least 10 characters.</span>}
          </label>
          {error && <p role="alert" className="rounded-lg bg-[#fff0e9] px-3 py-2.5 text-sm text-[#a33f28]">{error}</p>}
          <button type="submit" disabled={busy} className="w-full rounded-full bg-[#123b3d] px-5 py-3 text-sm font-semibold text-white hover:bg-[#205457] disabled:opacity-50">
            {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>
        <p className="mt-5 text-sm text-[#607779]">
          {mode === "login" ? "New to UrbanPulse?" : "Already have an account?"}{" "}
          <Link className="font-semibold text-[#a34325]" to={mode === "login" ? "/register" : "/login"}>{mode === "login" ? "Create an account" : "Sign in"}</Link>
        </p>
      </section>
    </main>
  );
}

function App() {
  const [auth, setAuth] = useState<AuthResult | null>(() => readAuth());

  useEffect(() => {
    const expireSession = () => setAuth(null);
    window.addEventListener("urbanpulse:auth-expired", expireSession);
    return () => window.removeEventListener("urbanpulse:auth-expired", expireSession);
  }, []);

  const saveAuth = (result: AuthResult) => {
    sessionStorage.setItem(authStorageKey, JSON.stringify(result));
    setAuth(result);
  };

  const logout = () => {
    if (auth) void signOut(auth.accessToken, auth.refreshToken).catch((error: unknown) => {
      console.error("Could not revoke refresh token during sign out", error);
    });
    sessionStorage.removeItem(authStorageKey);
    setAuth(null);
  };

  const home = auth?.user.role === "admin"
    ? <AdminNoiseMetrics accessToken={auth.accessToken} />
    : auth
      ? <CitizenDashboard accessToken={auth.accessToken} displayName={auth.user.display_name} onSignOut={logout} />
      : <Home />;

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={home} />
        <Route path="/admin" element={auth?.user.role === "admin"
          ? <AdminNoiseMetrics accessToken={auth.accessToken} />
          : <AuthPage mode="login" onAuthenticated={saveAuth} />} />
        <Route path="/login" element={auth
          ? <CitizenDashboard accessToken={auth.accessToken} displayName={auth.user.display_name} onSignOut={logout} />
          : <AuthPage mode="login" onAuthenticated={saveAuth} />} />
        <Route path="/register" element={auth
          ? <CitizenDashboard accessToken={auth.accessToken} displayName={auth.user.display_name} onSignOut={logout} />
          : <AuthPage mode="register" onAuthenticated={saveAuth} />} />
        <Route path="*" element={<Home />} />
      </Routes>
    </BrowserRouter>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
