import { useNavigate } from "react-router-dom";
import { Link } from "react-router-dom";
import { Icons } from "../components/icons";

const Section = ({ title, children }) => (
  <section className="mb-10">
    <h2 className="text-white text-lg font-semibold mb-3">{title}</h2>
    <div className="text-neutral-400 text-sm leading-relaxed space-y-3">{children}</div>
  </section>
);

const CookieTypeCard = ({ name, description, examples, canDisable }) => (
  <div className="border border-neutral-800 rounded-xl p-4 space-y-2">
    <div className="flex items-center justify-between">
      <span className="text-white font-medium text-sm">{name}</span>
      <span className={`text-xs px-2 py-0.5 rounded-full ${canDisable ? "bg-neutral-800 text-neutral-400" : "bg-neutral-700 text-neutral-300"}`}>
        {canDisable ? "Optional" : "Required"}
      </span>
    </div>
    <p className="text-neutral-400 text-xs leading-relaxed">{description}</p>
    {examples && (
      <p className="text-neutral-500 text-xs">Examples: {examples}</p>
    )}
  </div>
);

const CookiesPage = () => {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <header className="sticky top-0 z-10 bg-neutral-950/90 backdrop-blur-md border-b border-neutral-800 px-4 py-3 flex items-center gap-3">
        <button
          onClick={() => navigate(-1)}
          className="p-2 rounded-full hover:bg-neutral-800 transition-colors"
          aria-label="Go back"
        >
          <Icons.back className="w-5 h-5 text-white" />
        </button>
        <Icons.logo className="w-7 h-7" />
        <span className="text-white font-semibold">Cookies Policy</span>
      </header>

      <main className="max-w-2xl mx-auto px-5 py-10">
        <p className="text-neutral-500 text-xs mb-10">Last updated: May 7, 2026</p>

        <p className="text-neutral-400 text-sm leading-relaxed mb-10">
          This Cookies Policy explains how Gossips ("we", "us", or "our") uses cookies and
          similar tracking technologies when you use the Gossips platform. It explains what
          these technologies are, why we use them, and your rights to control our use of them.
        </p>

        <Section title="1. What Are Cookies?">
          <p>
            Cookies are small text files placed on your device (computer, smartphone, or tablet)
            when you visit a website or use an application. They are widely used to make
            websites and apps work more efficiently, provide a better user experience, and
            give website owners useful information about how their service is being used.
          </p>
          <p>
            Cookies can be "first-party" (set directly by Gossips) or "third-party" (set by
            third parties such as analytics or advertising services). They can also be
            "session cookies" (deleted when you close your browser) or "persistent cookies"
            (that remain on your device for a set period or until you delete them).
          </p>
          <p>
            In addition to cookies, we may use other similar tracking technologies such as
            web beacons (also called "pixel tags"), local storage, and software development
            kits (SDKs) in our mobile applications. This policy covers all such technologies
            collectively.
          </p>
        </Section>

        <Section title="2. Types of Cookies We Use">
          <div className="space-y-3">
            <CookieTypeCard
              name="Strictly Necessary"
              canDisable={false}
              description="These cookies are essential for the Service to function and cannot be switched off. They are usually set in response to actions you take, such as logging in, setting your privacy preferences, or filling out forms. Without these cookies, the Service cannot be provided."
              examples="Authentication tokens, session identifiers, CSRF protection tokens, load balancing"
            />
            <CookieTypeCard
              name="Performance & Analytics"
              canDisable={true}
              description="These cookies help us understand how visitors interact with the Service by collecting and reporting information anonymously. They allow us to count visits, see which features are most popular, and identify areas for improvement. We use Google Analytics and similar tools for this purpose."
              examples="Google Analytics (_ga, _gid), page view counters, feature usage metrics"
            />
            <CookieTypeCard
              name="Functional"
              canDisable={true}
              description="These cookies enable the Service to provide enhanced functionality and personalization based on your preferences. They may be set by us or by third-party providers whose services we have added to our pages. If you disable these cookies, some features may not work as expected."
              examples="Language and region preferences, theme settings, notification preferences, auto-fill data"
            />
            <CookieTypeCard
              name="Advertising & Targeting"
              canDisable={true}
              description="These cookies are set through our site by our advertising partners to build a profile of your interests and show you relevant ads on other sites. They work by uniquely identifying your browser and device. If you disable these cookies, you will still see ads, but they will be less relevant to you."
              examples="Meta Pixel (Facebook Pixel), retargeting pixels, conversion tracking, interest-based ad identifiers"
            />
          </div>
        </Section>

        <Section title="3. Third-Party Cookies">
          <p>
            Some cookies on our Service are set by third parties. These third parties may
            include analytics providers, advertising networks, and social media platforms.
            We do not control these third-party cookies or how the data collected is used.
            We encourage you to review the privacy and cookie policies of any third-party
            services we use:
          </p>
          <ul className="list-disc pl-5 space-y-2">
            <li>
              <strong className="text-white">Google Analytics</strong> — collects anonymized
              usage data to help us understand how the Service is used.
              Review Google's privacy policy at google.com/policies/privacy.
            </li>
            <li>
              <strong className="text-white">Meta (Facebook) Pixel</strong> — enables
              conversion tracking and retargeting for advertising campaigns on Meta platforms.
              Review Meta's cookie policy at facebook.com/policies/cookies.
            </li>
            <li>
              <strong className="text-white">Google Sign-In</strong> — enables authentication
              via Google accounts. Cookies may be set as part of this flow.
              Review Google's privacy policy at google.com/policies/privacy.
            </li>
          </ul>
          <p>
            This list is not exhaustive and may change over time. You can use browser developer
            tools to see all cookies set on any given page.
          </p>
        </Section>

        <Section title="4. How to Manage & Disable Cookies">
          <p>
            You have several options for managing cookies:
          </p>

          <p>
            <strong className="text-white">Browser Settings.</strong> Most browsers allow you
            to control cookies through their settings. You can set your browser to refuse all
            cookies, or to alert you when a cookie is being set. Note that disabling strictly
            necessary cookies may prevent the Service from working properly.
          </p>

          <ul className="list-disc pl-5 space-y-1">
            <li>Chrome: Settings → Privacy and security → Cookies</li>
            <li>Firefox: Settings → Privacy & Security → Cookies and Site Data</li>
            <li>Safari: Preferences → Privacy → Manage Website Data</li>
            <li>Edge: Settings → Cookies and site permissions</li>
          </ul>

          <p>
            <strong className="text-white">Opt-Out Tools.</strong> You can opt out of
            interest-based advertising from participating companies using the following tools:
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li>Google Analytics opt-out: tools.google.com/dlpage/gaoptout</li>
            <li>Network Advertising Initiative opt-out: optout.networkadvertising.org</li>
            <li>Digital Advertising Alliance opt-out: optout.aboutads.info</li>
            <li>European Interactive Digital Advertising Alliance: youronlinechoices.eu</li>
          </ul>

          <p>
            <strong className="text-white">Mobile Devices.</strong> On mobile devices, you
            can limit ad tracking through your device settings:
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li>iOS: Settings → Privacy & Security → Tracking → disable "Allow Apps to Request to Track"</li>
            <li>Android: Settings → Privacy → Ads → Opt out of Ads Personalization</li>
          </ul>

          <p>
            Please note that opting out of advertising cookies does not mean you will no
            longer see advertisements — it means the ads you see will be less personalized
            to your interests.
          </p>
        </Section>

        <Section title="5. Do Not Track Signals">
          <p>
            Some browsers include a "Do Not Track" (DNT) feature that signals to websites
            that you do not want to be tracked. Because there is currently no universally
            accepted standard for how websites should respond to DNT signals, we do not
            currently respond to browser DNT signals.
          </p>
          <p>
            However, you can manage your cookie preferences using the controls described in
            Section 4 above, and you can opt out of third-party interest-based advertising
            through the tools listed there.
          </p>
        </Section>

        <Section title="6. Changes to This Cookies Policy">
          <p>
            We may update this Cookies Policy from time to time to reflect changes in the
            cookies and tracking technologies we use, or for other legal, operational, or
            regulatory reasons. When we make material changes, we will update the "Last updated"
            date at the top of this page and, where appropriate, notify you via in-app
            notification or email.
          </p>
          <p>
            We encourage you to revisit this policy periodically to stay informed about
            our use of cookies.
          </p>
        </Section>

        <Section title="7. Contact Information">
          <p>
            If you have any questions about our use of cookies or this Cookies Policy,
            please contact us:
          </p>
          <ul className="list-none space-y-1">
            <li>
              Email:{" "}
              <a href="mailto:privacy@gossips.app" className="text-white underline underline-offset-2">
                privacy@gossips.app
              </a>
            </li>
          </ul>
        </Section>

        <div className="pt-6 border-t border-neutral-800 flex flex-wrap gap-4 text-xs text-neutral-500">
          <Link to="/terms" className="hover:text-white transition-colors">Gossips Terms</Link>
          <Link to="/privacy" className="hover:text-white transition-colors">Privacy Policy</Link>
        </div>
      </main>
    </div>
  );
};

export default CookiesPage;
