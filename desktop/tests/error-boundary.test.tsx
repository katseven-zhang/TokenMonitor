import { describe,expect,it,beforeAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n';
import { ErrorBoundary, FailureNotice } from '../src/components/error-boundary';

beforeAll(async()=>{
  // The notice reads its copy from the locale tables now, so the instance has to be
  // initialised before a render (same setup `currency-settings.test.tsx` uses).
  await i18n.changeLanguage('zh');
});

describe('failure notice',()=>{
  it('states what failed and offers the way out',()=>{
    const html=renderToStaticMarkup(<FailureNotice title="本地数据读取失败" message="数据库被占用" onRetry={()=>{}} onClose={()=>{}}/>);
    expect(html).toContain('role="alert"');
    expect(html).toContain('本地数据读取失败');
    expect(html).toContain('数据库被占用');
    expect(html).toContain('重试');
    expect(html).toContain('关闭此栏');
  });

  it('does not offer a retry it cannot perform',()=>{
    expect(renderToStaticMarkup(<FailureNotice message="读取失败"/>)).not.toContain('重试');
  });
});

describe('error boundary',()=>{
  it('renders the guarded region while it is healthy',()=>{
    const html=renderToStaticMarkup(<ErrorBoundary label="分析界面"><p>dashboard</p></ErrorBoundary>);
    expect(html).toContain('dashboard');
    expect(html).not.toContain('无法显示');
  });
});
