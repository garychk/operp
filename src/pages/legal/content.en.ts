import type { LegalDoc } from './types';

/**
 * English copy. Bracketed values (e.g. OPERP) must be replaced
 * with real operator details before publishing.
 * Section ids must stay identical to content.zh.ts, otherwise TOC anchors break
 * when switching languages.
 */

const CONTACT_BLOCKS = [
  { kind: 'list' as const, items: [
    'Operating entity: OPERP',
    'Registered address: Wuxi.JiangSu.China',
    'Privacy & data protection: privacy@oplug.cn',
    'Customer support: support@oplug.cn',
    'Service hours: Monday to Friday, 09:00-18:00 (UTC+8)',
  ] },
];

const terms: LegalDoc = {
  slug: 'terms',
  title: 'Terms of Service',
  updatedAt: '2026-10-05',
  summary: 'The agreement between you and us governing your use of the OPERP business management platform.',
  intro:
    'Welcome to OPERP. These Terms of Service ("Terms") are a legal agreement between you and OPERP ("we", "us") regarding your access to and use of the OPERP cloud platform together with its website, clients, APIs and AI-assisted features (collectively, the "Service").',
  sections: [
    {
      id: 'acceptance',
      heading: '1. Acceptance of Terms',
      blocks: [
        { kind: 'p', text: 'By creating an account, provisioning a tenant, or otherwise accessing the Service, you confirm that:' },
        { kind: 'list', items: [
          'You are at least 18 years old, or duly authorised by your organisation;',
          'You have read, understood and agreed to be bound by these Terms and the Privacy Policy;',
          'If you are signing on behalf of a company or other entity, you are authorised to bind that entity.',
        ] },
        { kind: 'callout', text: 'If you do not agree to these Terms, stop using the Service immediately. Continuing to use the Service after an update constitutes acceptance of the revised Terms.' },
      ],
    },
    {
      id: 'service',
      heading: '2. Description of the Service',
      blocks: [
        { kind: 'p', text: 'OPERP is a cloud-delivered enterprise resource planning system covering financial accounting, inventory and supply chain, manufacturing and planning, workflow approval and reporting, together with AI-assisted querying and data processing capabilities.' },
        { kind: 'sub', text: '2.1 Nature of the Service' },
        { kind: 'p', text: 'The Service is an intangible digital product delivered over the internet. Access is granted immediately once provisioning is confirmed. Because delivery is instantaneous, refunds are subject to the limits described in section 4.' },
        { kind: 'sub', text: '2.2 Service levels and changes' },
        { kind: 'p', text: 'We continuously evolve the product and may add, adjust or retire features. Material changes affecting core functionality will be announced in advance via in-product notice or your registered email. Interface and capability changes driven by product iteration do not constitute a breach.' },
        { kind: 'sub', text: '2.3 Scheduled maintenance' },
        { kind: 'p', text: 'We may perform scheduled maintenance to protect stability. Non-urgent maintenance is scheduled outside peak business hours wherever possible and announced in advance. Interruptions caused by force majeure, telecommunications or cloud provider failures will be restored on a best-effort basis.' },
      ],
    },
    {
      id: 'account',
      heading: '3. Accounts and Security',
      blocks: [
        { kind: 'p', text: 'You must register an account with accurate and complete information. You are responsible for all activity occurring under your account and must keep your credentials safe.' },
        { kind: 'list', items: [
          'Do not share, lend or transfer your account to any third party;',
          'Notify us immediately at[security@oplug.cn]if you suspect unauthorised access or abnormal sign-in activity;',
          'Keep your billing and notification email address valid so you receive security and service notices.',
        ] },
        { kind: 'p', text: 'Member accounts within an enterprise tenant are administered by that tenant\'s administrator, who is responsible for data configuration, member permissions and operational activity inside the tenant.' },
      ],
    },
    {
      id: 'fees',
      heading: '4. Fees, Billing and Refunds',
      blocks: [
        { kind: 'p', text: 'The Service is billed per subscription period. Plans, prices and entitlements are those shown on the order page or in a signed order form. If a subscription is not renewed, we retain data for [90] days before deletion.' },
        { kind: 'list', items: [
          'Fees are non-refundable once paid, except where required by law or agreed otherwise in writing;',
          'If we fail to deliver the Service, we will refund the unused portion on a pro-rata basis;',
          'For billing disputes, email [billing@oplug.cn] first. We reply within 2 business days and resolve confirmed errors within 5 business days.',
        ] },
      ],
    },
    {
      id: 'content',
      heading: '5. Content and Intellectual Property',
      blocks: [
        { kind: 'sub', text: '5.1 Your data belongs to you' },
        { kind: 'p', text: 'Business data that you or your organisation enter, upload or generate while using the Service ("Customer Data") remains yours or your organisation\'s. We process it only to deliver the Service, meet legal obligations, or as you authorise, and claim no ownership over it.' },
        { kind: 'sub', text: '5.2 Licence you grant us' },
        { kind: 'p', text: 'You grant us a limited, non-exclusive licence to store, transmit, display and back up Customer Data as necessary to operate the Service. We will not use your business data to train AI models without your explicit consent or a legal requirement.' },
        { kind: 'sub', text: '5.3 AI-generated content' },
        { kind: 'p', text: 'Content generated by AI features from your inputs ("Output") may be used by you for lawful business purposes, subject to these Terms. Output is machine-generated and may be inaccurate, incomplete or out of date; review and verify it before relying on it.' },
        { kind: 'sub', text: '5.4 Our intellectual property' },
        { kind: 'p', text: 'Software code, interface design, documentation, trademarks, model orchestration and algorithms of the Service are owned by us or our licensors. Without written permission you may not copy, reverse engineer, modify, redistribute, or build derivative products on the Service.' },
      ],
    },
    {
      id: 'aup',
      heading: '6. Acceptable Use Policy',
      blocks: [
        { kind: 'p', text: 'You may use the Service only for lawful business, management and development purposes, and agree not to:' },
        { kind: 'list', items: [
          'Create, store or distribute content that violates law, infringes others\' rights, or is contrary to public order;',
          'Build malware, phishing pages, or conduct attacks, intrusions, or circumvention of security controls;',
          'Interfere with or disrupt the Service or its underlying infrastructure, or run unauthorised stress tests or vulnerability scans;',
          'Resell, sublicense or otherwise provide access to the Service to third parties without written permission;',
          'Use inputs or outputs of the Service to train, fine-tune, distil or benchmark AI models that compete with it;',
          'Pass AI-generated content off as the advice of licensed professionals such as accountants, lawyers or physicians in contexts where harm may result.',
        ] },
        { kind: 'p', text: 'We may investigate suspected violations and, depending on severity, restrict features, suspend or terminate the Service.' },
      ],
    },
    {
      id: 'third-party',
      heading: '7. Third-Party Services and AI Models',
      blocks: [
        { kind: 'p', text: 'The Service integrates third-party cloud infrastructure, payment channels and AI model capabilities. Availability and output quality may be affected by those providers, and we will notify you of material upstream outages.' },
        { kind: 'p', text: 'We do not warrant the quality of any particular output and accept no liability for content generated by third-party models. Your use of third-party services is also subject to their own terms and policies.' },
      ],
    },
    {
      id: 'termination',
      heading: '8. Term, Suspension and Termination',
      blocks: [
        { kind: 'p', text: 'These Terms take effect when you begin using the Service and remain in force until the relationship ends. We may suspend or terminate the Service where:' },
        { kind: 'list', items: [
          'You materially breach these Terms or the Acceptable Use Policy and fail to cure within a reasonable period after notice;',
          'There is suspected fraud, money laundering or other illegality, or a lawful request from a judicial or regulatory authority;',
          'Fees remain unpaid after a demand for payment.',
        ] },
        { kind: 'p', text: 'After termination you may request a data export within [90] days; thereafter we delete or anonymise the data as agreed. Fees are not refunded where termination results from your breach; where it does not, we refund prepaid unused fees pro rata.' },
      ],
    },
    {
      id: 'disclaimer',
      heading: '9. Disclaimers and Limitation of Liability',
      blocks: [
        { kind: 'p', text: 'The Service is provided "as is" and "as available". To the maximum extent permitted by law we disclaim all warranties, express or implied, including merchantability, fitness for a particular purpose and accuracy of AI output.' },
        { kind: 'callout', text: 'AI output does not constitute legal, tax, medical or investment advice. Always have a qualified professional review it before acting on it or disclosing it externally.' },
        { kind: 'p', text: 'To the maximum extent permitted by law we are not liable for indirect, incidental, consequential or punitive damages, nor for lost profits, data loss or business interruption. Our aggregate liability is capped at the fees you actually paid in the [12] months preceding the event giving rise to the claim.' },
      ],
    },
    {
      id: 'law',
      heading: '10. Governing Law and Dispute Resolution',
      blocks: [
        { kind: 'p', text: 'These Terms are governed by the laws of the People\'s Republic of China. Disputes shall first be resolved through friendly negotiation; failing that, either party may bring an action before the competent people\'s court at the location of OPERP.' },
      ],
    },
    {
      id: 'contact',
      heading: '11. Updates and Contact',
      blocks: [
        { kind: 'p', text: 'We may revise these Terms from time to time. Material changes will be announced at least [14] days before they take effect via in-product notice or your registered email; continued use constitutes acceptance. If any provision is held invalid, the remainder stays in full force.' },
        ...CONTACT_BLOCKS,
      ],
    },
  ],
  footer: 'OPERP · OPERP',
};

const privacy: LegalDoc = {
  slug: 'privacy',
  title: 'Privacy Policy',
  updatedAt: '2026-10-05',
  summary: 'What we collect, why we collect it, how it is stored and shared, and the rights you have over your information.',
  intro:
    'OPERP ("we", "us") understands how important personal information is to you. This Privacy Policy explains how we collect, use, store, share and protect your personal information and business data when you use the OPERP cloud service (the "Service"), and the rights you have under applicable law.',
  sections: [
    {
      id: 'controller',
      heading: '1. Data Controller',
      blocks: [
        { kind: 'p', text: 'The controller of personal information for the Service is OPERP, registered at Wuxi.JiangSu.China. If you have questions or complaints about our processing, contact us using the details in section 10.' },
      ],
    },
    {
      id: 'collect',
      heading: '2. Information We Collect',
      blocks: [
        { kind: 'sub', text: '2.1 Information you provide' },
        { kind: 'list', items: [
          'Account and identity: name, email, phone number, login name, organisation and role;',
          'Entity details: company name, tax ID, address and bank details of your business;',
          'Business data: customers, suppliers, products, orders, vouchers and production records you enter;',
          'Correspondence: support tickets, emails, feedback and our responses.',
        ] },
        { kind: 'sub', text: '2.2 Information collected automatically' },
        { kind: 'list', items: [
          'Device and network: IP address, device model, operating system, browser type and language, time zone;',
          'Usage: pages visited, features used, timestamps and session duration;',
          'Logs and security: request time, API responses, error and performance logs, abnormal sign-in records.',
        ] },
        { kind: 'p', text: 'We do not collect precise location, contacts, photo libraries or other information unrelated to the Service. If a future feature requires a new category of data, we will inform you and obtain consent first.' },
      ],
    },
    {
      id: 'usage',
      heading: '3. How We Use Information',
      blocks: [
        { kind: 'p', text: 'We use your information only within the scope below, always on a minimum-necessary basis:' },
        { kind: 'table', head: ['Purpose', 'Description'],
          rows: [
            ['Deliver and maintain the Service', 'Account setup, tenant configuration, business processing and storage'],
            ['Billing and settlement', 'Calculate subscription fees, issue invoices, handle billing disputes'],
            ['Customer support', 'Respond to tickets, troubleshoot, follow up and survey satisfaction'],
            ['Security and risk control', 'Identity verification, anomaly detection, anti-fraud and audit trails'],
            ['Service notices', 'Billing, security alerts, service changes and policy updates'],
            ['Product improvement', 'Analyse de-identified or aggregated usage to improve features and performance'],
            ['Legal compliance', 'Meet statutory duties and cooperate with regulators and judicial process'],
          ] },
        { kind: 'p', text: 'We may aggregate or de-identify data for statistical analysis. Such data cannot be linked to an individual and will not be re-identified.' },
      ],
    },
    {
      id: 'cookie',
      heading: '4. Cookies and Similar Technologies',
      blocks: [
        { kind: 'p', text: 'We use cookies and local storage to keep you signed in, remember interface preferences and analyse usage. You can manage or delete cookies in your browser settings, but disabling strictly necessary cookies may prevent parts of the Service from working.' },
        { kind: 'table', head: ['Category', 'Purpose', 'Can be disabled'],
          rows: [
            ['Strictly necessary', 'Session continuity, load balancing and security', 'No'],
            ['Preferences', 'Remember language, theme and table layout', 'Yes'],
            ['Analytics', 'Anonymous statistics on visits and feature usage', 'Yes'],
          ] },
      ],
    },
    {
      id: 'share',
      heading: '5. Sharing, Transfer and Disclosure',
      blocks: [
        { kind: 'p', text: 'We do not sell your personal information. We share it only in these circumstances:' },
        { kind: 'list', items: [
          'Service providers: cloud, communications, payment, support and operations vendors under confidentiality obligations, processing only on our instructions;',
          'Payments: card data is handled solely by PCI-DSS compliant processors and is not stored on our servers;',
          'Legal and regulatory: where required by law, court order or a lawful request from an authority;',
          'Corporate transactions: on merger, split, restructuring or asset transfer, we notify you in advance and ensure obligations continue;',
          'With your consent: for any other purpose after obtaining your explicit prior consent.',
        ] },
      ],
    },
    {
      id: 'security',
      heading: '6. Security Safeguards',
      blocks: [
        { kind: 'p', text: 'We apply industry-standard technical and organisational measures to protect your information:' },
        { kind: 'list', items: [
          'Encryption in transit: TLS/HTTPS across the platform to prevent interception or tampering;',
          'Encryption at rest: credentials stored irreversibly, key data encrypted on disk;',
          'Access control: least privilege, role-based internal authorisation and confidentiality agreements;',
          'Tenant isolation: row-level security policies enforce strict separation between tenants;',
          'Continuous protection: regular security audits, vulnerability scanning and backup recovery drills.',
        ] },
        { kind: 'p', text: 'If a security incident affecting your rights occurs, we will notify you and the relevant regulator within [72] hours as required by law. Please safeguard your credentials and never share them.' },
      ],
    },
    {
      id: 'retention',
      heading: '7. Retention and Location',
      blocks: [
        { kind: 'table', head: ['Data type', 'Retention period', 'Action at expiry'],
          rows: [
            ['Account and identity', 'Duration of service; [90] days after closure', 'Delete or anonymise'],
            ['Business data', 'Duration of service; [90] days after termination', 'Delete or export as instructed'],
            ['Transaction and invoice records', 'As required by law, typically [5] years', 'Delete or archive'],
            ['Support tickets', '[3] years', 'Secure deletion'],
            ['Security audit logs', '[12] months', 'Secure deletion'],
          ] },
        { kind: 'p', text: 'Your information is stored on servers located in the People\'s Republic of China. Where a cross-border transfer is genuinely necessary, we will complete the required security assessment or execute standard contractual clauses and obtain your consent.' },
      ],
    },
    {
      id: 'rights',
      heading: '8. Your Rights',
      blocks: [
        { kind: 'p', text: 'Subject to applicable law you may exercise the following rights. We will respond within [30] calendar days of receiving your request:' },
        { kind: 'table', head: ['Right', 'Description'],
          rows: [
            ['Information and access', 'Understand what we process and obtain a copy'],
            ['Rectification', 'Correct inaccurate or incomplete information'],
            ['Erasure', 'Request deletion in defined circumstances'],
            ['Restriction', 'Ask us to pause processing in defined circumstances'],
            ['Portability', 'Receive data you provided in a common, machine-readable format'],
            ['Withdraw consent', 'Withdraw a previously given authorisation'],
            ['Close account', 'Close your account and request deletion or export'],
          ] },
        { kind: 'p', text: 'If you believe our processing harms your rights and we cannot resolve it together, you may complain to your local personal information protection authority or bring legal action.' },
      ],
    },
    {
      id: 'minors',
      heading: '9. Protection of Minors',
      blocks: [
        { kind: 'p', text: 'The Service is built for enterprise management and is not directed at individuals under 18. We do not knowingly collect information from minors. If you are a guardian and believe a child has provided information to us, contact us and we will verify and delete it promptly.' },
      ],
    },
    {
      id: 'contact',
      heading: '10. Updates and Contact',
      blocks: [
        { kind: 'p', text: 'We may revise this Policy. Material changes will be announced at least [15] days before they take effect via in-product notice or your registered email, and the "Last updated" date at the top will change. Continuing to use the Service after the effective date means you accept the revised Policy.' },
        ...CONTACT_BLOCKS,
      ],
    },
  ],
  footer: 'OPERP · OPERP',
};

export const legalEn: Record<'terms' | 'privacy', LegalDoc> = { terms, privacy };
