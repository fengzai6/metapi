import { useEffect, useMemo, useState } from 'react';
import CenteredModal from '../../components/CenteredModal.js';
import ModernSelect from '../../components/ModernSelect.js';
import { api } from '../../api.js';
import { useToast } from '../../components/Toast.js';
import { tr } from '../../i18n.js';
import type { RouteCandidateView, RouteAccountOption, RouteTokenOption } from '../helpers/routeModelCandidatesIndex.js';
import type { RouteMissingTokenHint } from '../helpers/routeMissingTokenHints.js';
import {
  buildFixedTokenOptionDescription,
  buildFixedTokenOptionLabel,
  describeTokenBinding,
} from './tokenBindingPresentation.js';

type ChannelSelection = {
  accountId: number;
  tokenId?: number;
  sourceModel?: string;
};

type SelectableAccount = RouteAccountOption & {
  missingGroups?: string[];
  kind: 'candidate' | 'missing_group';
};

type LoadedTokenOption = RouteTokenOption & {
  tokenGroup?: string | null;
  modelAvailable?: boolean;
};

type AccountTokenRow = {
  id: number;
  name?: string | null;
  isDefault?: boolean | null;
  enabled?: boolean | null;
  valueStatus?: string | null;
  tokenGroup?: string | null;
};

type AddChannelModalProps = {
  open: boolean;
  onClose: () => void;
  routeId: number;
  routeTitle: string;
  candidateView: RouteCandidateView;
  onSuccess: () => void;
  missingTokenHints?: RouteMissingTokenHint[];
  missingTokenGroupHints?: RouteMissingTokenHint[];
  onCreateTokenForMissing?: (accountId: number, modelName: string) => void;
  existingChannelAccountIds?: Set<number>;
};

function isUsableAccountTokenRow(token: AccountTokenRow): boolean {
  if (token.enabled === false) return false;
  if (token.valueStatus && token.valueStatus !== 'ready') return false;
  return Number.isFinite(token.id) && token.id > 0;
}

function buildTokenDescription(token: LoadedTokenOption): string {
  if (token.modelAvailable) {
    return buildFixedTokenOptionDescription(token);
  }
  const group = (token.tokenGroup || '').trim() || '未知分组';
  return token.isDefault
    ? `分组 ${group}；目前也是账号默认，但以后不会自动跟随`
    : `分组 ${group}；未出现在模型候选中，可手动绑定`;
}

export default function AddChannelModal({
  open,
  onClose,
  routeId,
  routeTitle,
  candidateView,
  onSuccess,
  missingTokenHints,
  missingTokenGroupHints,
  onCreateTokenForMissing,
  existingChannelAccountIds,
}: AddChannelModalProps) {
  const toast = useToast();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedAccounts, setSelectedAccounts] = useState<Record<number, ChannelSelection>>({});
  const [tokensByAccountId, setTokensByAccountId] = useState<Record<number, LoadedTokenOption[]>>({});
  const [loadingTokensByAccountId, setLoadingTokensByAccountId] = useState<Record<number, boolean>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) return;
    setSelectedAccounts({});
    setSearchQuery('');
    setTokensByAccountId({});
    setLoadingTokensByAccountId({});
  }, [open]);

  const selectableAccounts = useMemo(() => {
    const accounts = new Map<number, SelectableAccount>();
    for (const option of candidateView.accountOptions) {
      accounts.set(option.id, { ...option, kind: 'candidate' });
    }
    for (const hint of missingTokenGroupHints || []) {
      for (const account of hint.accounts) {
        if (!Number.isFinite(account.accountId) || account.accountId <= 0) continue;
        const existing = accounts.get(account.accountId);
        const missingGroups = Array.isArray(account.missingGroups) ? account.missingGroups : [];
        if (existing) {
          if (missingGroups.length === 0) continue;
          const merged = Array.from(new Set([...(existing.missingGroups || []), ...missingGroups]))
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
          existing.missingGroups = merged;
          continue;
        }
        accounts.set(account.accountId, {
          id: account.accountId,
          label: `${account.username || `account-${account.accountId}`} @ ${account.siteName}`,
          missingGroups: [...missingGroups],
          kind: 'missing_group',
        });
      }
    }
    return Array.from(accounts.values()).sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  }, [candidateView.accountOptions, missingTokenGroupHints]);

  const selectableAccountIds = useMemo(
    () => new Set(selectableAccounts.map((account) => account.id)),
    [selectableAccounts],
  );

  const filteredAccounts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return selectableAccounts;
    return selectableAccounts.filter((option) => option.label.toLowerCase().includes(q));
  }, [selectableAccounts, searchQuery]);

  const missingAccounts = useMemo(() => {
    if (!missingTokenHints || missingTokenHints.length === 0) return [];
    const seen = new Map<number, { accountId: number; label: string; modelName: string }>();
    for (const hint of missingTokenHints) {
      for (const account of hint.accounts) {
        if (selectableAccountIds.has(account.accountId)) continue;
        if (!seen.has(account.accountId)) {
          const label = `${account.username || `account-${account.accountId}`} @ ${account.siteName}`;
          seen.set(account.accountId, { accountId: account.accountId, label, modelName: hint.modelName });
        }
      }
    }
    return Array.from(seen.values());
  }, [missingTokenHints, selectableAccountIds]);

  const filteredMissingAccounts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return missingAccounts;
    return missingAccounts.filter((item) => item.label.toLowerCase().includes(q));
  }, [missingAccounts, searchQuery]);

  const selectedCount = Object.keys(selectedAccounts).length;

  const resolveTokensForAccount = (accountId: number): LoadedTokenOption[] => {
    if (tokensByAccountId[accountId]) return tokensByAccountId[accountId];
    return (candidateView.tokenOptionsByAccountId[accountId] || []).map((token) => ({
      ...token,
      modelAvailable: true,
    }));
  };

  const loadTokensForAccount = async (accountId: number) => {
    if (tokensByAccountId[accountId] || loadingTokensByAccountId[accountId]) return;
    setLoadingTokensByAccountId((prev) => ({ ...prev, [accountId]: true }));
    try {
      const rows = await api.getAccountTokens(accountId) as AccountTokenRow[];
      const candidateTokens = candidateView.tokenOptionsByAccountId[accountId] || [];
      const candidateById = new Map(candidateTokens.map((token) => [token.id, token]));
      const loadedReady = (Array.isArray(rows) ? rows : [])
        .filter(isUsableAccountTokenRow)
        .map((row) => ({
          id: row.id,
          name: String(row.name || `token-${row.id}`),
          isDefault: !!row.isDefault,
          tokenGroup: row.tokenGroup || null,
          modelAvailable: candidateById.has(row.id),
          sourceModel: candidateById.get(row.id)?.sourceModel,
        }));

      // Keep candidate rows (may include sourceModel variants), then append non-candidate tokens.
      const merged: LoadedTokenOption[] = [
        ...candidateTokens.map((token) => ({
          ...token,
          tokenGroup: loadedReady.find((row) => row.id === token.id)?.tokenGroup || null,
          modelAvailable: true,
        })),
      ];
      const seenIds = new Set(merged.map((token) => token.id));
      for (const token of loadedReady) {
        if (seenIds.has(token.id)) continue;
        merged.push(token);
        seenIds.add(token.id);
      }
      merged.sort((a, b) => {
        if (a.modelAvailable !== b.modelAvailable) return a.modelAvailable ? -1 : 1;
        if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
        if (a.id !== b.id) return a.id - b.id;
        return (a.sourceModel || '').localeCompare(b.sourceModel || '', undefined, { sensitivity: 'base' });
      });
      setTokensByAccountId((prev) => ({ ...prev, [accountId]: merged }));
    } catch (e: any) {
      toast.error(e?.message || tr('加载账号令牌失败'));
      setTokensByAccountId((prev) => ({
        ...prev,
        [accountId]: (candidateView.tokenOptionsByAccountId[accountId] || []).map((token) => ({
          ...token,
          modelAvailable: true,
        })),
      }));
    } finally {
      setLoadingTokensByAccountId((prev) => {
        const next = { ...prev };
        delete next[accountId];
        return next;
      });
    }
  };

  const toggleAccount = (account: SelectableAccount) => {
    setSelectedAccounts((prev) => {
      if (prev[account.id]) {
        const next = { ...prev };
        delete next[account.id];
        return next;
      }
      void loadTokensForAccount(account.id);
      return {
        ...prev,
        [account.id]: {
          accountId: account.id,
        },
      };
    });
  };

  const updateTokenForAccount = (accountId: number, tokenId: number, sourceModel: string) => {
    setSelectedAccounts((prev) => {
      if (!prev[accountId]) return prev;
      return {
        ...prev,
        [accountId]: {
          ...prev[accountId],
          tokenId: tokenId || undefined,
          sourceModel: sourceModel || undefined,
        },
      };
    });
  };

  const handleSubmit = async () => {
    const channels = Object.values(selectedAccounts);
    if (channels.length === 0) return;

    setSubmitting(true);
    try {
      const result = await api.batchAddChannels(routeId, channels);
      const msg = `已添加 ${result.created} 个通道` +
        (result.skipped > 0 ? `，跳过 ${result.skipped} 个重复` : '') +
        (result.errors.length > 0 ? `，${result.errors.length} 个错误` : '');
      toast.success(msg);
      setSelectedAccounts({});
      setSearchQuery('');
      onSuccess();
      onClose();
    } catch (e: any) {
      toast.error(e.message || '批量添加通道失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    if (!submitting) {
      setSelectedAccounts({});
      setSearchQuery('');
      onClose();
    }
  };

  return (
    <CenteredModal
      open={open}
      onClose={handleClose}
      title={`${tr('添加通道')} - ${routeTitle}`}
      maxWidth={560}
      footer={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
          <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            {tr('已选')} {selectedCount} {tr('个通道')}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" onClick={handleClose} disabled={submitting}>
              {tr('取消')}
            </button>
            <button
              className="btn btn-primary"
              onClick={handleSubmit}
              disabled={submitting || selectedCount === 0}
            >
              {submitting ? (
                <><span className="spinner spinner-sm" /> {tr('添加中...')}</>
              ) : (
                `${tr('批量添加')} (${selectedCount})`
              )}
            </button>
          </div>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="toolbar-search" style={{ width: '100%' }}>
          <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={tr('搜索账号...')}
          />
        </div>

        <div style={{ maxHeight: 360, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {filteredAccounts.length === 0 && filteredMissingAccounts.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--color-text-muted)', padding: '12px 0', textAlign: 'center' }}>
              {selectableAccounts.length === 0 && missingAccounts.length === 0
                ? tr('当前没有可用的账号，请确认已有账号的令牌支持调用此模型')
                : tr('没有匹配的账号')}
            </div>
          ) : (
            <>
              {filteredAccounts.map((account) => {
                const isSelected = !!selectedAccounts[account.id];
                const tokens = resolveTokensForAccount(account.id);
                const selection = selectedAccounts[account.id];
                const isExisting = existingChannelAccountIds?.has(account.id);
                const isLoadingTokens = !!loadingTokensByAccountId[account.id];
                const tokenBinding = describeTokenBinding(tokens, selection?.tokenId || 0);
                const missingGroupsLabel = (account.missingGroups || []).join('、');

                return (
                  <div
                    key={account.id}
                    onClick={() => toggleAccount(account)}
                    style={{
                      padding: '8px 10px',
                      borderRadius: 'var(--radius-sm)',
                      border: `1px solid ${isSelected ? 'var(--color-primary)' : 'var(--color-border)'}`,
                      background: isSelected ? 'color-mix(in srgb, var(--color-primary) 6%, transparent)' : 'transparent',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        readOnly
                        style={{ cursor: 'pointer', pointerEvents: 'none' }}
                      />
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{account.label}</span>
                      {isExisting && (
                        <span className="badge badge-muted" style={{ fontSize: 10 }}>{tr('已添加')}</span>
                      )}
                      {missingGroupsLabel && (
                        <span className="badge badge-warning" style={{ fontSize: 10 }}>
                          {tr('缺少分组')}: {missingGroupsLabel}
                        </span>
                      )}
                    </div>

                    {isSelected && (
                      <div style={{ marginTop: 6, paddingLeft: 24 }} onClick={(e) => e.stopPropagation()}>
                        <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 4 }}>{tr('令牌绑定')}:</div>
                        {isLoadingTokens ? (
                          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span className="spinner spinner-sm" />
                            {tr('加载账号令牌...')}
                          </div>
                        ) : (
                          <>
                            <ModernSelect
                              size="sm"
                              value={(() => {
                                if (!selection?.tokenId) return '0';
                                return `${selection.tokenId}::${selection.sourceModel || ''}`;
                              })()}
                              onChange={(nextValue) => {
                                if (nextValue === '0') {
                                  updateTokenForAccount(account.id, 0, '');
                                  return;
                                }
                                const [tokenRaw, ...sourceParts] = nextValue.split('::');
                                updateTokenForAccount(account.id, Number.parseInt(tokenRaw, 10) || 0, sourceParts.join('::'));
                              }}
                              options={[
                                {
                                  value: '0',
                                  label: tr('跟随账号默认'),
                                  description: tokenBinding.followOptionDescription,
                                },
                                ...tokens.map((token) => ({
                                  value: `${token.id}::${token.sourceModel || ''}`,
                                  label: buildFixedTokenOptionLabel(token, {
                                    includeDefaultTag: true,
                                    includeSourceModel: true,
                                  }),
                                  description: buildTokenDescription(token),
                                })),
                              ]}
                              placeholder={tr('选择绑定方式')}
                            />
                            <div style={{ marginTop: 4, fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.4 }}>
                              {tokens.length === 0
                                ? tr('该账号暂无可用令牌，可先同步/创建令牌后再绑定')
                                : tokenBinding.helperText}
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Missing token hints */}
              {filteredMissingAccounts.length > 0 && (
                <div style={{ borderTop: '1px dashed var(--color-border)', paddingTop: 8, marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 2 }}>
                    {tr('以下账号可用此模型但缺少令牌')}:
                  </div>
                  {filteredMissingAccounts.map((item) => (
                    <div
                      key={item.accountId}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '6px 10px', borderRadius: 'var(--radius-sm)',
                        border: '1px dashed var(--color-border)', background: 'var(--color-bg)',
                      }}
                    >
                      <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{item.label}</span>
                      {onCreateTokenForMissing && (
                        <button
                          type="button"
                          className="btn btn-link"
                          style={{ fontSize: 11, padding: '2px 6px' }}
                          onClick={() => onCreateTokenForMissing(item.accountId, item.modelName)}
                        >
                          {tr('创建令牌')}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </CenteredModal>
  );
}
