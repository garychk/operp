import { LegalPage } from './LegalPage';
import { legalZh } from './content.zh';
import { legalEn } from './content.en';

/**
 * 服务条款（/terms）—— 无需登录即可访问的静态文本页。
 */
const Terms = () => <LegalPage slug="terms" docsZh={legalZh} docsEn={legalEn} />;

export default Terms;
