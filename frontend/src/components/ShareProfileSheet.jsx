import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Download, ScanLine } from "lucide-react";
import { toast } from "react-hot-toast";
import ResponsiveSheet from "./ui/responsive-sheet";
import ProfileQRCode from "./ProfileQRCode";
import QRScannerSheet from "./QRScannerSheet";
import { scannedCodeRoute } from "../lib/scannedCode";
import ShareSheet from "./ShareSheet";
import { Icons } from "./icons";
import { buildProfileUrl } from "../lib/profileLink";
import { downloadQrPng } from "../lib/qrDownload";

/**
 * Share profile — the QR code, and the ways out of it.
 *
 * `Share to` hands off to the same ShareSheet posts use, so a profile can be sent
 * into a DM or a group with the same recipient list, group creation and external
 * destinations. Nothing here is duplicated from it.
 */


const ActionRow = ({ icon, label, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-neutral-800 cursor-pointer"
  >
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-800 text-white">
      {icon}
    </span>
    <span className="text-[14px] font-medium text-white">{label}</span>
  </button>
);

const ShareProfileSheet = ({ username, userId, onClose }) => {
  const navigate = useNavigate();
  const [scannerOpen, setScannerOpen] = useState(false);
  const [shareToOpen, setShareToOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const profileUrl = buildProfileUrl(username);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(profileUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Couldn't copy the link");
    }
  };

  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      await downloadQrPng({ value: profileUrl, caption: username, filename: `gossips-${username}` });
    } catch {
      toast.error("Couldn't save the QR code");
    } finally {
      setDownloading(false);
    }
  };

  // The scanner replaces this sheet rather than stacking on it — two sheets deep
  // makes the back gesture ambiguous.
  if (scannerOpen) {
    return (
      <QRScannerSheet
        onFound={(result) => {
          const route = scannedCodeRoute(result);
          if (!route) return;
          setScannerOpen(false);
          onClose();
          // A profile or a group invite — the scanner recognises both, and the route
          // comes from the parsed result rather than from the scanned text.
          navigate(route);
        }}
        onClose={() => setScannerOpen(false)}
      />
    );
  }

  if (shareToOpen) {
    return (
      <ShareSheet
        targetType="profile"
        targetId={userId}
        authorUsername={username}
        onClose={() => setShareToOpen(false)}
      />
    );
  }

  return (
    <ResponsiveSheet title="Share profile" onClose={onClose}>
      {/* Sized to fit the sheet without scrolling: the QR is the tallest thing
          here, so it's capped in vh as well as px — on a short screen it shrinks
          rather than pushing the buttons out of reach. */}
      <div className="px-4 pb-4 pt-3">
        <div className="mx-auto w-[min(200px,30vh)] rounded-2xl border border-neutral-800 bg-neutral-950 p-3.5">
          <ProfileQRCode
            value={profileUrl}
            label={`QR code for @${username}`}
            className="w-full"
          />
        </div>

        <p className="mt-3 text-center text-[15px] font-semibold text-white">@{username}</p>
        <p className="mt-0.5 text-center text-[12px] text-neutral-500">
          Scan this code to open this profile
        </p>

        <div className="mt-4 flex items-center gap-2.5">
          <button
            type="button"
            onClick={download}
            disabled={downloading}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-white py-2.5 text-[14px] font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-60 cursor-pointer"
          >
            <Download className="h-4 w-4" />
            {downloading ? "Saving…" : "Download"}
          </button>
          <button
            type="button"
            onClick={() => setScannerOpen(true)}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-neutral-700 py-2.5 text-[14px] font-semibold text-white transition-colors hover:bg-neutral-800 cursor-pointer"
          >
            <ScanLine className="h-4 w-4" />
            Scan
          </button>
        </div>

        <div className="mt-3 border-t border-neutral-800 pt-1">
          <ActionRow
            icon={copied ? <Icons.checkCircle /> : <Icons.copy />}
            label={copied ? "Link copied" : "Copy link"}
            onClick={copyLink}
          />
          <ActionRow
            icon={<Icons.shareTo />}
            label="Share to"
            onClick={() => setShareToOpen(true)}
          />
        </div>
      </div>
    </ResponsiveSheet>
  );
};

export default ShareProfileSheet;
