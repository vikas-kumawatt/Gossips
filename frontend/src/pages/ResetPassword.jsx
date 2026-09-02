import React, { useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import InputBox from "../components/InputBox";
import { Toaster, toast } from "react-hot-toast";
import axios from "axios";
import { Loader2 } from "lucide-react";
import { Icons } from "../components/icons";

const PASSWORD_RULE =
  "6-20 characters, with a lowercase letter, an uppercase letter and a number";
const passwordRegex = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{6,20}$/;

const ResetPassword = () => {
  const { token } = useParams();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  /*
   * Controlled, so the two fields can be compared while they are being typed.
   *
   * They were read out of `FormData` on submit, which meant a mismatch — the
   * common failure on a screen with two adjacent password boxes — surfaced only
   * as a toast, after the fact, pointing at neither field and then vanishing on
   * its own. You were left looking at two identical-looking boxes with no idea
   * which one to fix.
   */
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  // Not while the confirm field is still empty: nobody wants to be told they
  // got it wrong before they have finished the first keystroke.
  const mismatch = confirmPassword.length > 0 && password !== confirmPassword;

  const handleResetPassword = async (e) => {
    e.preventDefault();

    if (!password) {
      return toast.error("Please enter a new password");
    }

    if (!passwordRegex.test(password)) {
      return toast.error(`Your password must be ${PASSWORD_RULE}`);
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
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {/* Stated up front. The rule was previously discoverable only by
            breaking it and reading the toast. */}
        <p className="w-full -mt-2 mb-4 text-xs text-neutral-500">{PASSWORD_RULE}</p>

        <InputBox
          name="confirmPassword"
          type="password"
          placeholder="Confirm Password"
          icon="fi-rr-key"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          error={mismatch ? "Passwords do not match" : undefined}
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