import { LegalPage } from './LegalPage';
import { legalZh } from './content.zh';
import { legalEn } from './content.en';

/**
 * 隐私政策（/privacy）—— 无需登录即可访问的静态文本页。
 */
const Privacy = () => <LegalPage slug="privacy" docsZh={legalZh} docsEn={legalEn} />;

export default Privacy;
