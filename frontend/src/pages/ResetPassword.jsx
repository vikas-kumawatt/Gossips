import React, { useState, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import InputBox from "../components/InputBox";
import { Toaster, toast } from "react-hot-toast";
import axios from "axios";
import { Loader2 } from "lucide-react";

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
        className="w-[80%] max-w-[400px] flex flex-col items-center"
      >
        <img
          src="../images/logo.png"
          alt="Gossips Logo"
          className="w-20 h-20 mb-4 mx-auto"
        />
        <h1 className="text-white font-bold mb-4">Set New Password</h1>
        <InputBox name="password" type="password" placeholder="New Password" />
        <InputBox
          name="confirmPassword"
          type="password"
          placeholder="Confirm Password"
        />
        <button
          type="submit"
          className="w-[100%] rounded-xl p-4 text-black font-medium bg-white border border-transparent cursor-pointer flex items-center justify-center gap-2"
          onClick={handleResetPassword}
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
      </form>
    </section>
  );
};

export default ResetPassword;