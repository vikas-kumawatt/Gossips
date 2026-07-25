import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Icons } from "../components/icons";

const Section = ({ title, children }) => (
  <section className="mb-10">
    <h2 className="text-white text-lg font-semibold mb-3">{title}</h2>
    <div className="text-neutral-400 text-sm leading-relaxed space-y-3">{children}</div>
  </section>
);

/**
 * Destination for "Learn more" in the AI info sheet. Follows the same shape as
 * the other static pages (terms, privacy, cookies).
 */
const AiLabelsPage = () => {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <header className="sticky top-0 z-10 bg-neutral-950/90 backdrop-blur-md border-b border-neutral-800 px-4 py-3 flex items-center gap-3">
        <button
          onClick={() => navigate(-1)}
          className="p-2 rounded-full hover:bg-neutral-800 transition-colors cursor-pointer"
          aria-label="Go back"
        >
          <ArrowLeft className="w-5 h-5 text-white" />
        </button>
        <h1 className="text-white font-semibold">AI labels</h1>
      </header>

      <main className="max-w-2xl mx-auto px-5 py-8">
        <div className="flex items-center gap-2 mb-8">
          <span className="inline-flex items-center gap-1 rounded-full border border-neutral-700 bg-neutral-800/60 text-neutral-300 px-2 py-[2px] text-[11px]">
            <Icons.ai className="w-3.5 h-3.5" />
            AI info
          </span>
          <span className="text-neutral-500 text-sm">is what the label looks like.</span>
        </div>

        <Section title="What the label means">
          <p>
            When you see an AI info label on a post or a comment, it means the
            person who posted it told us AI was involved in making it. Tapping
            the label shows you who added it.
          </p>
          <p>
            AI covers a wide range of uses. It might be a photo that was touched
            up or had an object removed, a caption that was rewritten, or an
            image, video or piece of writing generated from scratch. The label
            says AI was used somewhere — it doesn't say how much.
          </p>
        </Section>

        <Section title="What the label doesn't mean">
          <p>
            An AI label is not a judgement. Labelled content isn't lower quality,
            less trustworthy, or against our rules. Plenty of ordinary posts use
            AI somewhere in the process.
          </p>
          <p>
            Just as importantly, the absence of a label doesn't guarantee that no
            AI was used. Not all AI-generated content carries the technical
            signals we would need to recognise it automatically, so today this
            label depends on people disclosing it themselves.
          </p>
        </Section>

        <Section title="Adding a label to your own post">
          <p>
            When you're writing a post or a reply, open the menu in the top-right
            of the composer and choose <span className="text-neutral-200">Add AI label</span>.
            Anyone who can see your post will then see the label.
          </p>
          <p>
            Changed your mind? Open the post's menu, choose{" "}
            <span className="text-neutral-200">Edit</span>, and turn the label off
            there. Adding or removing a label on its own doesn't mark your post
            as edited, and it isn't recorded in the post's edit history.
          </p>
        </Section>

        <Section title="If a label is missing or wrong">
          <p>
            Only the author can add or remove the label on their own content. If
            you believe something is AI-generated and presented in a misleading
            way, you can report it — open the post's menu, choose{" "}
            <span className="text-neutral-200">Report</span>, and pick{" "}
            <span className="text-neutral-200">False information</span> →{" "}
            <span className="text-neutral-200">Digitally altered or AI-generated media</span>.
          </p>
        </Section>

        <p className="text-neutral-600 text-xs border-t border-neutral-800 pt-6">
          We expect this to change as detection improves. If we're ever able to
          identify AI content reliably on our own, we'll update this page before
          relying on it.
        </p>
      </main>
    </div>
  );
};

export default AiLabelsPage;
