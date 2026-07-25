import { useNavigate } from "react-router-dom";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Icons } from "../components/icons";

const Section = ({ title, children }) => (
  <section className="mb-10">
    <h2 className="text-white text-lg font-semibold mb-3">{title}</h2>
    <div className="text-neutral-400 text-sm leading-relaxed space-y-3">{children}</div>
  </section>
);

const TermsPage = () => {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <header className="sticky top-0 z-10 bg-neutral-950/90 backdrop-blur-md border-b border-neutral-800 px-4 py-3 flex items-center gap-3">
        <button
          onClick={() => navigate(-1)}
          className="p-2 rounded-full hover:bg-neutral-800 transition-colors"
          aria-label="Go back"
        >
          <ArrowLeft className="w-5 h-5 text-white" />
        </button>
        <Icons.logo className="w-7 h-7" />
        <span className="text-white font-semibold">Gossips Terms of Service</span>
      </header>

      <main className="max-w-2xl mx-auto px-5 py-10">
        <p className="text-neutral-500 text-xs mb-10">Last updated: May 7, 2026</p>

        <p className="text-neutral-400 text-sm leading-relaxed mb-10">
          Welcome to Gossips. These Terms of Service ("Terms") govern your access to and use of
          the Gossips platform, including our website, mobile applications, and services
          (collectively, the "Service"). Please read these Terms carefully before using
          the Service.
        </p>

        <Section title="1. Acceptance of Terms">
          <p>
            By creating an account, accessing, or using the Service in any way, you agree to
            be bound by these Terms and our{" "}
            <Link to="/privacy" className="text-white underline underline-offset-2">
              Privacy Policy
            </Link>{" "}
            and{" "}
            <Link to="/cookies" className="text-white underline underline-offset-2">
              Cookies Policy
            </Link>
            . If you do not agree to these Terms, you may not access or use the Service.
          </p>
          <p>
            These Terms constitute a legally binding agreement between you and Gossips. Your
            continued use of the Service after any updates to these Terms constitutes acceptance
            of the revised Terms.
          </p>
        </Section>

        <Section title="2. Eligibility">
          <p>
            You must be at least 13 years of age to use the Service. If you are between 13 and
            18 years of age (or the age of legal majority in your jurisdiction), you may only
            use the Service with the consent and supervision of a parent or legal guardian who
            agrees to be bound by these Terms.
          </p>
          <p>
            By using the Service, you represent and warrant that: (a) you meet the minimum age
            requirement; (b) you have the legal capacity to enter into a binding agreement;
            (c) all registration information you provide is accurate, current, and complete;
            and (d) you are not prohibited from using the Service under applicable law.
          </p>
          <p>
            We reserve the right to terminate or suspend accounts that we reasonably believe
            belong to users who do not meet these eligibility requirements.
          </p>
        </Section>

        <Section title="3. Account Registration & Security">
          <p>
            To access most features of the Service, you must create an account. You agree to
            provide accurate, current, and complete information during registration and to
            update such information to keep it accurate, current, and complete.
          </p>
          <p>
            You are solely responsible for maintaining the confidentiality of your account
            credentials and for all activity that occurs under your account. You agree to
            immediately notify us at{" "}
            <a href="mailto:security@gossips.app" className="text-white underline underline-offset-2">
              security@gossips.app
            </a>{" "}
            of any unauthorized use of your account or any other security breach.
          </p>
          <p>
            You may not share your account credentials with any third party, create accounts
            by automated means, or use another user's account without their express permission.
            We cannot and will not be liable for any loss or damage arising from your failure
            to protect your account credentials.
          </p>
        </Section>

        <Section title="4. User-Generated Content">
          <p>
            <strong className="text-white">Ownership.</strong> You retain all ownership rights
            to the content you create, post, share, or otherwise submit to the Service
            ("User Content"). These Terms do not transfer ownership of your User Content
            to Gossips.
          </p>
          <p>
            <strong className="text-white">License to Gossips.</strong> By submitting User
            Content to the Service, you grant Gossips a non-exclusive, royalty-free, worldwide,
            sublicensable, and transferable license to use, reproduce, modify, distribute,
            display, and perform your User Content in connection with operating and improving
            the Service, including for promotional and marketing purposes. This license
            terminates when you delete your User Content or your account, except where the
            content has been shared with others who have not deleted it.
          </p>
          <p>
            <strong className="text-white">Your Representations.</strong> You represent and
            warrant that: (a) you own or have the necessary rights to your User Content;
            (b) your User Content does not violate the rights of any third party; and (c) your
            User Content complies with these Terms and all applicable laws.
          </p>
          <p>
            <strong className="text-white">Content Removal.</strong> We reserve the right to
            remove any User Content at our sole discretion, with or without notice, for any
            reason, including content that violates these Terms or that we find objectionable.
          </p>
        </Section>

        <Section title="5. Acceptable Use Policy">
          <p>You agree not to use the Service to:</p>
          <ul className="list-disc pl-5 space-y-2">
            <li>
              Post, share, or transmit content that is harassing, threatening, abusive,
              defamatory, obscene, or otherwise objectionable.
            </li>
            <li>
              Engage in hate speech targeting individuals or groups based on race, ethnicity,
              national origin, gender, sexual orientation, religion, disability, or other
              protected characteristics.
            </li>
            <li>
              Impersonate any person or entity, or falsely state or misrepresent your
              affiliation with any person or entity.
            </li>
            <li>
              Post, distribute, or generate child sexual abuse material (CSAM) or any
              content that sexually exploits minors. Violations will be reported to the
              National Center for Missing & Exploited Children (NCMEC) and relevant
              law enforcement.
            </li>
            <li>
              Engage in spamming, phishing, or any form of unsolicited commercial communication.
            </li>
            <li>
              Upload or transmit malware, viruses, or any malicious code.
            </li>
            <li>
              Attempt to gain unauthorized access to any portion of the Service or any
              other systems or networks connected to the Service.
            </li>
            <li>
              Use automated means (bots, scrapers, crawlers) to access or interact with
              the Service without our prior written consent.
            </li>
            <li>
              Post content that promotes, facilitates, or glorifies illegal activities,
              including the sale of drugs, weapons, or human trafficking.
            </li>
            <li>
              Violate any applicable local, national, or international law or regulation.
            </li>
          </ul>
          <p>
            Gossips reserves the right to investigate and take appropriate legal action against
            anyone who, in Gossips's sole discretion, violates this provision, including
            reporting to law enforcement authorities.
          </p>
        </Section>

        <Section title="6. Intellectual Property">
          <p>
            <strong className="text-white">Our IP.</strong> The Service and its original
            content (excluding User Content), features, and functionality are and will remain
            the exclusive property of Gossips and its licensors. The Gossips name, logo, and
            all related names, logos, product and service names, designs, and slogans are
            trademarks of Gossips. You may not use such marks without our prior written
            permission.
          </p>
          <p>
            <strong className="text-white">DMCA / Copyright Takedown.</strong> We respect
            intellectual property rights and expect our users to do the same. If you believe
            that your copyrighted work has been used on the Service in a way that constitutes
            copyright infringement, please send a DMCA takedown notice to our designated agent
            at{" "}
            <a href="mailto:dmca@gossips.app" className="text-white underline underline-offset-2">
              dmca@gossips.app
            </a>{" "}
            with: (a) a description of the copyrighted work; (b) a description of the
            infringing material and its location on the Service; (c) your contact information;
            (d) a statement of good faith belief; and (e) a statement of accuracy under
            penalty of perjury.
          </p>
          <p>
            We will respond to valid DMCA notices by removing or disabling access to the
            allegedly infringing material. Repeat infringers may have their accounts terminated.
          </p>
        </Section>

        <Section title="7. Privacy">
          <p>
            Your privacy is important to us. Our{" "}
            <Link to="/privacy" className="text-white underline underline-offset-2">
              Privacy Policy
            </Link>{" "}
            explains how we collect, use, and share information about you when you use our
            Service. By using the Service, you agree that Gossips may collect and use
            information as described in the Privacy Policy.
          </p>
        </Section>

        <Section title="8. Third-Party Links & Services">
          <p>
            The Service may contain links to third-party websites, services, or advertisements
            that are not owned or controlled by Gossips. We have no control over, and assume
            no responsibility for, the content, privacy policies, or practices of any
            third-party websites or services.
          </p>
          <p>
            We strongly advise you to review the terms and privacy policies of any third-party
            websites or services that you visit. Your interactions with third-party services
            are solely between you and those third parties.
          </p>
        </Section>

        <Section title="9. Termination & Suspension">
          <p>
            We may terminate or suspend your account and access to the Service immediately,
            without prior notice or liability, for any reason, including if you breach these
            Terms. Upon termination, your right to use the Service will immediately cease.
          </p>
          <p>
            You may delete your account at any time through the Settings page. Deletion of
            your account does not relieve you of any obligations you have incurred prior to
            termination, and we may retain certain information as required by law or for
            legitimate business purposes.
          </p>
          <p>
            Provisions that by their nature should survive termination shall survive, including
            but not limited to intellectual property provisions, warranty disclaimers,
            indemnity, and limitations of liability.
          </p>
        </Section>

        <Section title="10. Disclaimers & Limitation of Liability">
          <p>
            THE SERVICE IS PROVIDED ON AN "AS IS" AND "AS AVAILABLE" BASIS WITHOUT ANY
            WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
            WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, OR
            NON-INFRINGEMENT.
          </p>
          <p>
            TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, GOSSIPS SHALL NOT BE LIABLE
            FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES,
            INCLUDING LOSS OF PROFITS, DATA, USE, GOODWILL, OR OTHER INTANGIBLE LOSSES,
            RESULTING FROM: (a) YOUR USE OF OR INABILITY TO USE THE SERVICE; (b) ANY
            UNAUTHORIZED ACCESS TO OR USE OF OUR SERVERS OR ANY PERSONAL INFORMATION;
            (c) ANY CONTENT OBTAINED FROM THE SERVICE; OR (d) ANY OTHER MATTER RELATING
            TO THE SERVICE.
          </p>
          <p>
            IN NO EVENT SHALL GOSSIPS'S TOTAL LIABILITY TO YOU FOR ALL CLAIMS EXCEED THE
            AMOUNT YOU PAID TO GOSSIPS IN THE PAST TWELVE (12) MONTHS, OR ONE HUNDRED
            DOLLARS ($100), WHICHEVER IS GREATER.
          </p>
        </Section>

        <Section title="11. Indemnification">
          <p>
            You agree to defend, indemnify, and hold harmless Gossips and its officers,
            directors, employees, contractors, agents, licensors, and suppliers from and
            against any claims, liabilities, damages, judgments, awards, losses, costs,
            expenses, or fees (including reasonable legal fees) arising out of or relating
            to your violation of these Terms or your use of the Service, including, but not
            limited to, your User Content, your connection to the Service, your violation
            of any third-party right, or your violation of any applicable law.
          </p>
        </Section>

        <Section title="12. Governing Law & Dispute Resolution">
          <p>
            These Terms shall be governed by and construed in accordance with applicable laws,
            without regard to conflict of law provisions.
          </p>
          <p>
            <strong className="text-white">Arbitration.</strong> Any dispute, controversy, or
            claim arising out of or relating to these Terms or the Service shall be resolved
            by binding arbitration rather than in court, except that you may assert claims in
            small claims court if your claims qualify. The arbitration shall be conducted by
            a recognized arbitration provider under its applicable rules. The arbitrator's
            decision shall be final and binding, and judgment on the award may be entered
            in any court of competent jurisdiction.
          </p>
          <p>
            <strong className="text-white">Class Action Waiver.</strong> You agree that any
            arbitration or legal proceeding shall be limited to the dispute between you and
            Gossips individually. You waive any right to participate in a class-action lawsuit
            or class-wide arbitration.
          </p>
          <p>
            <strong className="text-white">Opt-Out.</strong> You may opt out of the arbitration
            clause by sending written notice to{" "}
            <a href="mailto:legal@gossips.app" className="text-white underline underline-offset-2">
              legal@gossips.app
            </a>{" "}
            within 30 days of first accepting these Terms.
          </p>
        </Section>

        <Section title="13. Changes to Terms">
          <p>
            We reserve the right to modify or replace these Terms at any time at our sole
            discretion. If a revision is material, we will provide at least 30 days' notice
            prior to any new terms taking effect. What constitutes a material change will be
            determined at our sole discretion.
          </p>
          <p>
            We will notify you of changes by posting the updated Terms on this page and
            updating the "Last updated" date at the top, and/or by sending an in-app
            notification or email. Your continued use of the Service after changes become
            effective constitutes your acceptance of the revised Terms.
          </p>
        </Section>

        <Section title="14. Contact Information">
          <p>
            If you have any questions about these Terms, please contact us:
          </p>
          <ul className="list-none space-y-1">
            <li>
              Email:{" "}
              <a href="mailto:legal@gossips.app" className="text-white underline underline-offset-2">
                legal@gossips.app
              </a>
            </li>
            <li>DMCA / Copyright:{" "}
              <a href="mailto:dmca@gossips.app" className="text-white underline underline-offset-2">
                dmca@gossips.app
              </a>
            </li>
          </ul>
        </Section>

        <div className="pt-6 border-t border-neutral-800 flex flex-wrap gap-4 text-xs text-neutral-500">
          <Link to="/privacy" className="hover:text-white transition-colors">Privacy Policy</Link>
          <Link to="/cookies" className="hover:text-white transition-colors">Cookies Policy</Link>
        </div>
      </main>
    </div>
  );
};

export default TermsPage;
