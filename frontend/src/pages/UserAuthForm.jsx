import React, { useContext, useRef, useState } from "react";
import { useNavigate, Navigate } from "react-router-dom";
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
  const formRef = useRef(null);
  const [loading, setLoading] = useState(false);
  const [isForgotPassword, setIsForgotPassword] = useState(false);
  const [isReportModalOpen, setIsReportModalOpen] = useState(false);
  const forgotPasswordFormRef = useRef(null);

  const userAuthThroughServer = async (serverRoute, formData) => {
    setLoading(true);
    try {
      const { data } = await axios.post(
        import.meta.env.VITE_SERVER + serverRoute,
        formData,
        { withCredentials: true }
      );

      persistUser(data);

      setUserAuth((prevAuth) => ({
        ...prevAuth,
        ...data,
        token: data.token,
      }));

      toast.success(type === "signup" ? "Signed up successfully!" : "Logged in successfully!");
      navigate(data.newUser || type === "signup" ? "/profile-setup" : "/", {
        state: {
          from: "google-auth",
          newUser: data.newUser,
        },
      });
    } catch (error) {
      toast.error(error.response?.data?.error || "Authentication failed");
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

  if (token && type === "login") {
    return <Navigate to="/" />;
  }

  return (
    <section className="w-full h-screen flex justify-center items-center bg-neutral-950 relative">
      <Toaster />
      {isForgotPassword ? (
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
          <h1 className="text-white font-bold mb-4">
            {type === "login"
              ? "Log in with your Gossips account"
              : "Create your Gossips account"}
          </h1>

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