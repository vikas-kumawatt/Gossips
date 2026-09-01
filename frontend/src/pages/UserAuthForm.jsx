import React, { useContext, useRef, useState } from "react";
import { useNavigate, Navigate, useLocation, useSearchParams } from "react-router-dom";
import InputBox from "../components/InputBox";
import { Link } from "react-router-dom";
import { UserContext } from "../contexts/UserContext";
import { Toaster, toast } from "react-hot-toast";
import axios from "axios";
import { persistUser } from "../services/authSession";
import { authWithGoogle } from "../common/Firebase";
import { Loader2 } from "lucide-react";
import { Icons } from "../components/icons";
import DotQRCode from "../components/DotQRCode";
import ReportProblemModal from "../components/ReportProblemModal";

const UserAuthForm = ({ type }) => {
  const { userAuth: { token }, setUserAuth } = useContext(UserContext);
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  /*
   * Where to go after signing in, if we were sent here from somewhere.
   *
   * `ProtectedRoute` has always redirected with `state={{ from: location }}` and this
   * page has always ignored it — so signing in from any protected route landed on the
   * feed and lost wherever you were headed. That is merely annoying for most routes and
   * breaks the feature outright for a group invite link, whose entire job is to take a
   * signed-out visitor to one specific place.
   *
   * Accepts a location object (what ProtectedRoute sends) or a plain path string, and
   * only ever an internal path — a caller-supplied absolute URL here would be an open
   * redirect.
   */
  const redirectAfterAuth = (() => {
    const from = location.state?.from;
    const path = typeof from === "string" ? from : from?.pathname;
    if (!path || typeof path !== "string") return null;
    if (!path.startsWith("/") || path.startsWith("//")) return null;
    // Bouncing straight back to an auth page would loop.
    if (path === "/login" || path === "/signup") return null;
    return path;
  })();

  /*
   * "Add account" mode. The guard below sends a signed-in visitor straight
   * home, which is right for someone who wandered onto /login — and exactly
   * wrong for someone who is signed in and deliberately adding a second
   * account. `?add=1` is the switcher saying it meant this.
   */
  const isAddingAccount =
    type === "login" && searchParams.get("add") === "1" && Boolean(token);
  // Prefilled when re-authenticating an account whose session expired.
  const prefillLogin = searchParams.get("username") || "";
  const formRef = useRef(null);
  const [loading, setLoading] = useState(false);
  const [isForgotPassword, setIsForgotPassword] = useState(false);
  const [isReportModalOpen, setIsReportModalOpen] = useState(false);
  const forgotPasswordFormRef = useRef(null);

  /*
   * The request held between the two halves of a 2FA login.
   *
   * The first factor and the code check are one request on the server: it
   * re-verifies the password (or the Google token) every time, so the second
   * submit resends the same route and body plus `twoFactorCode`. Both login
   * routes can ask for a code, hence carrying the route rather than assuming
   * it. Non-null means "show the code step".
   */
  const [pendingTwoFactor, setPendingTwoFactor] = useState(null);
  const [twoFactorCode, setTwoFactorCode] = useState("");

  /*
   * Hand an unfinished signup to the OTP screen.
   *
   * `data` carries no token: signup now answers with a verification ticket and
   * the account does not exist until the emailed code is entered.
   */
  const goVerifyEmail = (data) => {
    navigate("/verify-email", {
      state: {
        verificationToken: data.verificationToken,
        email: data.email,
        codeLength: data.codeLength,
        expiresInSeconds: data.expiresInSeconds,
        resendAfterSeconds: data.resendAfterSeconds,
        // Carried through so the hard navigation below still happens on the
        // far side of verification.
        addingAccount: isAddingAccount,
        from: redirectAfterAuth,
      },
    });
  };

  const userAuthThroughServer = async (serverRoute, formData) => {
    setLoading(true);
    try {
      const { data } = await axios.post(
        import.meta.env.VITE_SERVER + serverRoute,
        formData,
        { withCredentials: true }
      );

      /*
       * No token in this response, by design — the account exists but has not
       * proved it owns its address. Nothing may be persisted here: `persistUser`
       * would write a user with no token, which is how the session layer spells
       * "signed out" and would clear the account currently signed in.
       */
      if (data.requiresVerification) {
        goVerifyEmail(data);
        return;
      }

      /*
       * Password was right, but the account has 2FA on. Same shape of trap as
       * the branch above — a 200 with no token — so it has to be caught before
       * `persistUser`, which would otherwise write a tokenless user and sign
       * out whoever is currently signed in.
       */
      if (data.needTwoFactor) {
        setPendingTwoFactor({ route: serverRoute, payload: formData });
        setTwoFactorCode("");
        return;
      }

      // Also records the account in this device's switcher list.
      persistUser(data);

      setUserAuth((prevAuth) => ({
        ...prevAuth,
        ...data,
        token: data.token,
      }));

      const goingToSetup = Boolean(data.newUser) || type === "signup";

      /*
       * Even on the way to profile setup, adding an account has to be a hard
       * navigation — the providers, socket and caches in memory belong to the
       * account we just left.
       */
      if (isAddingAccount && goingToSetup) {
        window.location.assign("/profile-setup");
        return;
      }

      if (isAddingAccount) {
        toast.success(`Switched to @${data.username}`);
        /*
         * A hard navigation, matching the switcher: every provider, cache and
         * socket belongs to the account we just left, and a request issued as
         * one account resolving as another is not a bug worth risking.
         */
        window.location.assign("/");
        return;
      }

      toast.success(type === "signup" ? "Signed up successfully!" : "Logged in successfully!");
      navigate(goingToSetup ? "/profile-setup" : redirectAfterAuth || "/", {
        state: {
          from: "google-auth",
          newUser: data.newUser,
        },
      });
    } catch (error) {
      const failure = error.response?.data;
      const message = failure?.error || "Authentication failed";
      /*
       * A wrong code now counts toward the same lockout a wrong password does,
       * so the count has to be visible here — otherwise the fifth typo locks
       * the account with no warning that a limit existed.
       *
       * Only here. The password step has always had `attemptsLeft` in the
       * response and has always ignored it; that is its own call, not one to
       * change on the way past. `formData` is the submitted body, so the
       * presence of a code is what tells the two steps apart.
       */
      const isTwoFactorStep = Boolean(formData.twoFactorCode);
      toast.error(
        isTwoFactorStep && typeof failure?.attemptsLeft === "number"
          ? `${message} — ${failure.attemptsLeft} attempt(s) left before lockout`
          : message
      );
    } finally {
      setLoading(false);
    }
  };

  const handleUserAuth = (e) => {
    e.preventDefault();

    const serverRoute = type === "login" ? "/auth/login" : "/auth/signup";
    const emailRegex = /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/;
    const passwordRegex = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{6,20}$/;

    const form = new FormData(formRef.current);
    const formData = Object.fromEntries(form.entries());

    const { name, email, password } = formData;

    if (type === "signup") {
      if (!name || name.length < 3) {
        return toast.error("Name must be more than 3 characters");
      }

      if (!email || !emailRegex.test(email)) {
        return toast.error("Enter a valid email");
      }
    } else {
      if (!formData.loginmethod) {
        return toast.error("Enter Username, Email, or Phone");
      }

      if (emailRegex.test(formData.loginmethod)) {
        formData.email = formData.loginmethod;
      } else {
        formData.username = formData.loginmethod;
      }

      delete formData.loginmethod;
    }

    if (!passwordRegex.test(password)) {
      return toast.error(
        "Your password must be 6-20 characters including a lowercase letter, an uppercase letter, and a number"
      );
    }

    userAuthThroughServer(serverRoute, formData);
  };

  const handleTwoFactorSubmit = (e) => {
    e.preventDefault();

    const code = twoFactorCode.trim().toUpperCase();
    // 6 digits from an authenticator app, or an 8-character backup code.
    if (!code) {
      return toast.error("Enter your authentication code");
    }

    userAuthThroughServer(pendingTwoFactor.route, {
      ...pendingTwoFactor.payload,
      twoFactorCode: code,
    });
  };

  const cancelTwoFactor = () => {
    setPendingTwoFactor(null);
    setTwoFactorCode("");
  };

  const handleGoogleAuth = async (e) => {
    e.preventDefault();

    try {
      const user = await authWithGoogle();
      const serverRoute = "/auth/googleLogin";
      const formData = { token: user.accessToken };
      await userAuthThroughServer(serverRoute, formData);
    } catch (error) {
      toast.error(error?.response?.data?.error || "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async (e) => {
    e.preventDefault();

    const emailRegex = /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/;
    const form = new FormData(forgotPasswordFormRef.current);
    const formData = Object.fromEntries(form.entries());
    const { email } = formData;

    if (!email || !emailRegex.test(email)) {
      return toast.error("Enter a valid email");
    }

    setLoading(true);
    try {
      await axios.post(`${import.meta.env.VITE_SERVER}/auth/forgot-password`, { email });
      toast.success("Password reset link sent to your email!");
      setIsForgotPassword(false);
    } catch (error) {
      toast.error(error.response?.data?.error || "Failed to send reset link");
    } finally {
      setLoading(false);
    }
  };

  /*
   * Signed in and not deliberately adding another account — nothing to do here.
   *
   * This is also the email/password success path: `setUserAuth` sets the token, the
   * component re-renders, and this redirect is what actually navigates. So honouring
   * `redirectAfterAuth` here is what carries someone back to the invite link (or
   * whatever protected route sent them) rather than dropping them on the feed.
   */
  if (token && type === "login" && !isAddingAccount) {
    return <Navigate to={redirectAfterAuth || "/"} replace />;
  }

  return (
    <section className="w-full h-screen flex justify-center items-center bg-neutral-950 relative">
      <Toaster />
      {pendingTwoFactor ? (
        <form
          onSubmit={handleTwoFactorSubmit}
          className="w-[80%] max-w-[400px] flex flex-col items-center"
        >
          <Icons.logo className="w-20 h-20 mb-4 mx-auto" />
          <h1 className="text-white font-bold mb-2 text-center">
            Two-factor authentication
          </h1>
          <p className="text-neutral-400 text-sm text-center mb-4">
            Enter the 6-digit code from your authenticator app, or one of your
            backup codes.
          </p>

          <div className="relative w-[100%] mb-4">
            <input
              name="twoFactorCode"
              type="text"
              placeholder="Authentication code"
              value={twoFactorCode}
              onChange={(e) => setTwoFactorCode(e.target.value)}
              autoFocus
              autoComplete="one-time-code"
              maxLength={8}
              className="input-box tracking-[0.3em] text-center"
            />
          </div>

          <button
            type="submit"
            className="w-[100%] rounded-xl p-4 text-black font-medium bg-white border border-transparent cursor-pointer flex items-center justify-center gap-2"
            disabled={loading}
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Verifying...
              </>
            ) : (
              "Verify"
            )}
          </button>

          <button
            type="button"
            className="text-neutral-500 text-center pt-4"
            onClick={cancelTwoFactor}
          >
            Back to Login
          </button>
        </form>
      ) : isForgotPassword ? (
        <form
          ref={forgotPasswordFormRef}
          className="w-[80%] max-w-[400px] flex flex-col items-center"
        >
          <Icons.logo className="w-20 h-20 mb-4 mx-auto" />
          <h1 className="text-white font-bold mb-4">Reset Your Password</h1>
          <InputBox name="email" type="email" placeholder="Email" />
          <button
            type="submit"
            className="w-[100%] rounded-xl p-4 text-black font-medium bg-white border border-transparent cursor-pointer flex items-center justify-center gap-2"
            onClick={handleForgotPassword}
            disabled={loading}
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Sending...
              </>
            ) : (
              "Send Reset Link"
            )}
          </button>
          <button
            type="button"
            className="text-neutral-500 text-center pt-4"
            onClick={() => setIsForgotPassword(false)}
          >
            Back to Login
          </button>
        </form>
      ) : (
        <form
          ref={formRef}
          className="w-[80%] max-w-[400px] flex flex-col items-center"
        >
          <Icons.logo className="w-20 h-20 mb-4 mx-auto" />
          <h1 className="text-white font-bold mb-4 text-center">
            {type !== "login"
              ? "Create your Gossips account"
              : isAddingAccount
                ? "Add another account"
                : "Log in with your Gossips account"}
          </h1>

          {/* Signing in here doesn't sign the current account out — worth
              saying, because every other login screen in existence does. */}
          {isAddingAccount && (
            <p className="text-neutral-400 text-sm text-center mb-4">
              You'll stay logged in to your other accounts and can switch back
              at any time.
            </p>
          )}

          {type === "signup" ? (
            <>
              <InputBox name="name" type="text" placeholder="Full Name" />
              <InputBox name="email" type="email" placeholder="Email" />
            </>
          ) : (
            <InputBox
              name="loginmethod"
              type="text"
              placeholder="Username, Phone or Email"
              // Filled in when re-authenticating an account whose session
              // expired, so it's a password away rather than a retype.
              value={prefillLogin}
            />
          )}
          <InputBox name="password" type="password" placeholder="Password" />

          <button
            type="submit"
            className="w-[100%] rounded-xl p-4 text-black font-medium bg-white border border-transparent cursor-pointer flex items-center justify-center gap-2"
            onClick={handleUserAuth}
            disabled={loading}
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {type === "login" ? "Logging in..." : "Signing up..."}
              </>
            ) : type === "login" ? (
              "Log in"
            ) : (
              "Sign up"
            )}
          </button>

          {type === "login" && (
            <button
              type="button"
              className="text-neutral-500 text-center pt-4"
              onClick={() => setIsForgotPassword(true)}
            >
              Forgot password?
            </button>
          )}

          <Link
            to={type === "login" ? "/signup" : "/login"}
            className="pt-4 text-white"
          >
            {type === "login"
              ? "Don't have an account? Sign up"
              : "Have an account? Log in"}
          </Link>

          <div className="w-[80%] flex items-center justify-center my-4">
            <hr className="w-[80%] border-neutral-500 my-4" />
            <p className="text-neutral-500 text-center px-2">or</p>
            <hr className="w-[80%] border-neutral-500 my-4" />
          </div>

          <button
            type="submit"
            className="w-[100%] rounded-xl p-4 text-white font-medium bg-neutral-950 border border-neutral-800 cursor-pointer flex items-center justify-center gap-2"
            onClick={handleGoogleAuth}
            disabled={loading}
          >
           <Icons.google className="mr-2 h-4 w-4" />
            Continue with Google
          </button>
        </form>
      )}

      <div className="flex flex-wrap text-nowrap gap-4 absolute bottom-4 text-neutral-500 text-sm mx-6 items-center justify-center">
        <p>© {new Date().getFullYear()}</p>
        <Link to="/terms" className="hover:text-white transition-colors">Gossips Terms</Link>
        <Link to="/privacy" className="hover:text-white transition-colors">Privacy Policy</Link>
        <Link to="/cookies" className="hover:text-white transition-colors">Cookies Policy</Link>
        <button
          type="button"
          onClick={() => setIsReportModalOpen(true)}
          className="hover:text-white transition-colors"
        >
          Report a problem
        </button>
      </div>

      <div className="absolute bottom-10 right-10 hidden md:block">
        <p className="text-neutral-500 text-sm text-center pb-2">
          Scan to get the app
        </p>
        <DotQRCode className="w-30 h-30 lg:w-45 lg:h-45 bg-neutral-900 p-2 rounded-2xl border border-neutral-700" />
      </div>

      <ReportProblemModal
        isOpen={isReportModalOpen}
        onClose={() => setIsReportModalOpen(false)}
      />
    </section>
  );
};

export default UserAuthForm;