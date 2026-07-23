import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { ToastProvider } from '../../components/Toast.js';
import AddChannelModal from './AddChannelModal.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAccountTokens: vi.fn(),
    batchAddChannels: vi.fn(),
  },
}));

vi.mock('../../api.js', () => ({
  api: apiMock,
}));

vi.mock('../../components/CenteredModal.js', () => ({
  default: ({ open, children, footer }: { open: boolean; children: React.ReactNode; footer?: React.ReactNode }) => (
    open ? <div data-testid="modal">{children}{footer}</div> : null
  ),
}));

vi.mock('../../components/ModernSelect.js', () => ({
  default: ({
    value,
    options,
    onChange,
  }: {
    value: string;
    options: Array<{ value: string; label: string; description?: string }>;
    onChange: (value: string) => void;
  }) => (
    <select
      data-testid="token-select"
      value={value}
      onChange={(event) => onChange((event.target as HTMLSelectElement).value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} data-description={option.description || ''}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('AddChannelModal', () => {
  it('lets missing-group accounts be selected and binds any account token', async () => {
    apiMock.getAccountTokens.mockResolvedValue([
      {
        id: 11,
        name: 'default',
        isDefault: true,
        enabled: true,
        valueStatus: 'ready',
        tokenGroup: 'default',
      },
      {
        id: 22,
        name: 'opus-hidden',
        isDefault: false,
        enabled: true,
        valueStatus: 'ready',
        tokenGroup: 'opus',
      },
    ]);
    apiMock.batchAddChannels.mockResolvedValue({ created: 1, skipped: 0, errors: [] });

    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <ToastProvider>
          <AddChannelModal
            open
            onClose={() => {}}
            routeId={7}
            routeTitle="claude-opus"
            candidateView={{ routeCandidates: [], accountOptions: [], tokenOptionsByAccountId: {} }}
            onSuccess={() => {}}
            missingTokenGroupHints={[
              {
                modelName: 'claude-opus-4',
                accounts: [{
                  accountId: 101,
                  username: 'user-a',
                  siteId: 1,
                  siteName: 'site-a',
                  missingGroups: ['opus'],
                  requiredGroups: ['default', 'opus'],
                  availableGroups: ['default'],
                }],
              },
            ]}
          />
        </ToastProvider>,
      );
    });

    const text = collectText(renderer!.root);
    expect(text).toContain('user-a @ site-a');
    expect(text).toContain('缺少分组');
    expect(text).toContain('opus');

    const accountRow = renderer!.root.find((node) => (
      typeof node.props?.onClick === 'function'
      && collectText(node).includes('user-a @ site-a')
    ));

    await act(async () => {
      accountRow.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(apiMock.getAccountTokens).toHaveBeenCalledWith(101);

    const select = renderer!.root.findByProps({ 'data-testid': 'token-select' });
    const optionValues = (select.children as ReactTestInstance[])
      .filter((child) => child.type === 'option')
      .map((child) => String(child.props.value));
    expect(optionValues).toContain('22::');

    await act(async () => {
      select.props.onChange({ target: { value: '22::' } });
    });

    const submit = renderer!.root.find((node) => (
      node.type === 'button'
      && collectText(node).includes('批量添加')
    ));

    await act(async () => {
      submit.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(apiMock.batchAddChannels).toHaveBeenCalledWith(7, [
      { accountId: 101, tokenId: 22, sourceModel: undefined },
    ]);
  });

  it('keeps pure missing-token accounts as create-token hints only', async () => {
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <ToastProvider>
          <AddChannelModal
            open
            onClose={() => {}}
            routeId={7}
            routeTitle="claude-opus"
            candidateView={{ routeCandidates: [], accountOptions: [], tokenOptionsByAccountId: {} }}
            onSuccess={() => {}}
            missingTokenHints={[
              {
                modelName: 'claude-opus-4',
                accounts: [{
                  accountId: 202,
                  username: 'user-b',
                  siteId: 2,
                  siteName: 'site-b',
                }],
              },
            ]}
            onCreateTokenForMissing={() => {}}
          />
        </ToastProvider>,
      );
    });

    const text = collectText(renderer!.root);
    expect(text).toContain('以下账号可用此模型但缺少令牌');
    expect(text).toContain('user-b @ site-b');
    expect(text).toContain('创建令牌');
    expect(text).not.toContain('缺少分组');
  });
});
