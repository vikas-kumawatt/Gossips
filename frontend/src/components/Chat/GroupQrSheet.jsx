import React, { useState } from "react";
import { Download, Share2 } from "lucide-react";
import { toast } from "react-hot-toast";
import ResponsiveSheet from "../ui/responsive-sheet";
import ProfileQRCode from "../ProfileQRCode";
import { downloadQrPng } from "../../lib/qrDownload";

/**
 * A group's invite link as a QR code.
 *
 * `ProfileQRCode` and `profileQr.js` are value-agnostic despite their names — the
 * generator takes any string — so this is the group's identity card wrapped around the
 * same code renderer the profile sheet uses. Its module tuned the ECC level and module
 * radius empirically against jsQR, so reimplementing would mean re-doing that.
 */
const GroupQrSheet = ({ group, inviteUrl, memberCount, onClose }) => {
  const [saving, setSaving] = useState(false);
  const name = group?.name || "Group";

  const share = async () => {
    /*
     * `navigator.share` with the *link*, not the image.
     *
     * Sharing a File needs `canShare({files})` and is refused outright on desktop
     * Safari and most desktop browsers; the link is what the QR encodes anyway, so
     * sharing it reaches every target including the ones that can't take a file. The
     * clipboard is the fallback where there's no share sheet at all.
     */
    try {
      if (navigator.share) {
        await navigator.share({ title: name, text: `Join ${name} on Gossips`, url: inviteUrl });
        return;
      }
      await navigator.clipboard.writeText(inviteUrl);
      toast.success("Link copied");
    } catch (err) {
      // An abort is the user closing the share sheet, which is not a failure.
      if (err?.name !== "AbortError") toast.error("Couldn't share that");
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await downloadQrPng({
        value: inviteUrl,
        caption: name,
        // Spaces and slashes in a group name would produce a broken download name.
        filename: `gossips-group-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
      });
    } catch {
      toast.error("Couldn't save the QR code");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ResponsiveSheet title="QR code" onClose={onClose}>
      <div className="px-5 pb-5 flex flex-col items-center">
        <img
          src={group?.avatar || "/default-group-avatar.png"}
          alt=""
          className="w-16 h-16 rounded-full object-cover border border-neutral-800 bg-neutral-900"
        />
        <h3 className="mt-3 text-base font-medium text-center">{name}</h3>
        <p className="text-xs text-neutral-500 mt-0.5">
          {memberCount} {memberCount === 1 ? "member" : "members"}
        </p>

        {/* Capped against the viewport height as well as the width: on a short phone in
            landscape a square sized only by width pushes the buttons off the sheet. */}
        <div className="mt-4 p-3 rounded-2xl bg-white w-[min(220px,32vh)]">
          <ProfileQRCode value={inviteUrl} label={name} />
        </div>

        <p className="mt-3 text-xs text-neutral-500 text-center max-w-[240px]">
          Scan this code to join {name}
        </p>

        <div className="flex gap-2 mt-5 w-full">
          <button
            type="button"
            onClick={share}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-neutral-900 hover:bg-neutral-800 text-sm font-medium"
          >
            <Share2 className="w-4 h-4" strokeWidth={2.1} />
            Share QR
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-neutral-900 hover:bg-neutral-800 text-sm font-medium disabled:opacity-60"
          >
            <Download className="w-4 h-4" strokeWidth={2.1} />
            {saving ? "Saving…" : "Save QR"}
          </button>
        </div>
      </div>
    </ResponsiveSheet>
  );
};

export default GroupQrSheet;
