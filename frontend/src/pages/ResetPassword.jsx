import React, { useState, useRef } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import InputBox from "../components/InputBox";
import { Toaster, toast } from "react-hot-toast";
import axios from "axios";
import { Loader2 } from "lucide-react";
import { Icons } from "../components/icons";

const ResetPassword = () => {
  const { token } = useParams();
  const navigate = useNavigate();
  const formRef = useRef(null);
  const [loading, setLoading] = useState(false);

  const handleResetPassword = async (e) => {
    e.preventDefault();

    const passwordRegex = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{6,20}$/;
    const form = new FormData(formRef.current);
    const formData = Object.fromEntries(form.entries());
    const { password, confirmPassword } = formData;

    if (!password) {
      return toast.error("Please enter a new password");
    }

    if (!passwordRegex.test(password)) {
      return toast.error(
        "Your password must be 6-20 characters including a lowercase letter, an uppercase letter, and a number"
      );
    }

    if (password !== confirmPassword) {
      return toast.error("Passwords do not match");
    }

    setLoading(true);
    try {
      await axios.post(`${import.meta.env.VITE_SERVER}/auth/reset-password`, {
        token,
        password,
      });
      toast.success("Password reset successfully! Please log in.");
      navigate("/login");
    } catch (error) {
      toast.error(error.response?.data?.error || "Failed to reset password");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="w-full h-screen flex justify-center items-center bg-neutral-950 relative">
      <Toaster />
      <form
        ref={formRef}
        onSubmit={handleResetPassword}
        className="w-[80%] max-w-[400px] flex flex-col items-center"
      >
        <Icons.logo className="w-20 h-20 mb-4 mx-auto" />
        <h1 className="text-white font-bold text-2xl mb-6">Set New Password</h1>

        <InputBox
          name="password"
          type="password"
          placeholder="New Password"
          icon="fi-rr-key"
          autoComplete="new-password"
        />

        <InputBox
          name="confirmPassword"
          type="password"
          placeholder="Confirm Password"
          icon="fi-rr-key"
          autoComplete="new-password"
        />

        <button
          type="submit"
          className="w-full rounded-xl p-4 text-black font-medium bg-white hover:bg-neutral-200 transition-colors border border-transparent cursor-pointer flex items-center justify-center gap-2 mt-2"
          disabled={loading}
        >
          {loading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Resetting...
            </>
          ) : (
            "Reset Password"
          )}
        </button>

        <p className="mt-6 text-neutral-400 text-sm">
          Remember your password?{" "}
          <Link to="/login" className="text-white underline hover:text-neutral-300">
            Log in
          </Link>
        </p>
      </form>
    </section>
  );
};

export default ResetPassword;