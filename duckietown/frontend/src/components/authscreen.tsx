import { useState } from "react";
import { Cloud, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

interface Props {
  onSignIn: () => Promise<void>;
}

export function AuthScreen({ onSignIn }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSignIn = async () => {
    setLoading(true);
    setError("");
    try {
      await onSignIn();
    } catch (e) {
      setError(String(e));
      setLoading(false);
    }
  };

  return (
    <div className="h-screen flex items-center justify-center bg-[#1c1c1c]">
      {/* Subtle grid background */}
      <div
        className="absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            "linear-gradient(rgb(212 212 212) 1px, transparent 1px), linear-gradient(90deg, rgb(212 212 212) 1px, transparent 1px)",
          backgroundSize: "40px 40px",
        }}
      />

      <div className="relative z-10 w-[400px] fade-in">
        {/* Logo */}
        <div className="flex flex-col items-center gap-3 mb-8">
          <div className="w-16 h-16 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
            <Cloud size={30} className="text-indigo-400" />
          </div>
          <div className="text-center">
            <h1 className="text-2xl font-bold text-[#d4d4d4] tracking-tight">
              Duckietown
            </h1>
            <p className="text-sm text-[#6a6a6a] mt-1">
              Your smart cloud file system
            </p>
          </div>
        </div>

        {/* Card */}
        <div className="bg-[#252526] border border-[#3e3e42] rounded-xl overflow-hidden shadow-2xl">
          <div className="px-6 py-5">
            <h2 className="text-sm font-semibold text-[#d4d4d4] mb-1">
              Sign in to continue
            </h2>
            <p className="text-xs text-[#6a6a6a]">
              Use your Google account to access your files
            </p>
          </div>

          <Separator className="bg-[#3e3e42]" />

          <div className="px-6 py-5 flex flex-col gap-3">
            <Button
              onClick={handleSignIn}
              disabled={loading}
              className="w-full h-10 bg-white hover:bg-gray-100 text-gray-800 font-medium gap-3 border border-[#3e3e42]"
            >
              {loading ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <GoogleIcon />
              )}
              {loading ? "Opening browser..." : "Continue with Google"}
            </Button>

            {error && (
              <p className="text-xs text-destructive text-center">{error}</p>
            )}
          </div>

          <Separator className="bg-[#3e3e42]" />

          <div className="px-6 py-4">
            <p className="text-[11px] text-[#4a4a4a] text-center leading-relaxed">
              Your browser will open for authentication.
              <br />
              Return to Duckietown once signed in.
            </p>
          </div>
        </div>

        <p className="mt-5 text-[11px] text-[#3a3a3a] font-mono text-center">
          Duckietown v0.1.0 · Files sync automatically to your vault
        </p>
      </div>
    </div>
  );
}

// Google "G" SVG icon
function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}
