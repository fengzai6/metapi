export type SortMode = 'custom' | 'balance-desc' | 'balance-asc';

type SortableBase = {
  id: number;
  isPinned?: boolean | null;
  sortOrder?: number | null;
  status?: string | null;
};

function getStatusPriority(status?: string | null): number {
  // 状态优先级：启用且正常 > 启用但异常 > 其他状态
  // 数字越小优先级越高
  if (!status || status === 'active') return 0; // 启用且正常
  if (status === 'expired' || status === 'failed' || status === 'error') return 1; // 启用但异常
  if (status === 'disabled') return 2; // 禁用
  return 3; // 其他状态
}

export function sortItemsForDisplay<T extends SortableBase>(
  items: T[],
  mode: SortMode,
  getBalance: (item: T) => number,
): T[] {
  const list = [...items];
  const customComparator = (a: T, b: T) => {
    // 1. 置顶优先
    const aPinned = a.isPinned ? 1 : 0;
    const bPinned = b.isPinned ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;

    // 2. 状态优先级（启用 > 启用异常 > 禁用）
    const aStatusPriority = getStatusPriority(a.status);
    const bStatusPriority = getStatusPriority(b.status);
    if (aStatusPriority !== bStatusPriority) return aStatusPriority - bStatusPriority;

    // 3. 自定义排序
    const aOrder = Number.isFinite(a.sortOrder as number) ? Number(a.sortOrder) : Number.MAX_SAFE_INTEGER;
    const bOrder = Number.isFinite(b.sortOrder as number) ? Number(b.sortOrder) : Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) return aOrder - bOrder;

    // 4. ID 排序
    return a.id - b.id;
  };

  if (mode === 'custom') {
    return list.sort(customComparator);
  }

  return list.sort((a, b) => {
    const aPinned = a.isPinned ? 1 : 0;
    const bPinned = b.isPinned ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;

    const aBalance = Number.isFinite(getBalance(a)) ? getBalance(a) : 0;
    const bBalance = Number.isFinite(getBalance(b)) ? getBalance(b) : 0;
    if (aBalance !== bBalance) {
      return mode === 'balance-desc' ? bBalance - aBalance : aBalance - bBalance;
    }

    return customComparator(a, b);
  });
}

export function buildCustomReorderUpdates<T extends SortableBase>(
  items: T[],
  targetId: number,
  direction: 'up' | 'down',
): Array<{ id: number; sortOrder: number }> {
  const sorted = sortItemsForDisplay(items, 'custom', () => 0);
  const target = sorted.find((item) => item.id === targetId);
  if (!target) return [];

  const targetPinned = !!target.isPinned;
  const group = sorted.filter((item) => !!item.isPinned === targetPinned);
  const index = group.findIndex((item) => item.id === targetId);
  if (index < 0) return [];

  const swapIndex = direction === 'up' ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= group.length) return [];

  const next = [...group];
  const temp = next[index];
  next[index] = next[swapIndex];
  next[swapIndex] = temp;

  const updates: Array<{ id: number; sortOrder: number }> = [];
  next.forEach((item, idx) => {
    const prev = Number.isFinite(item.sortOrder as number) ? Number(item.sortOrder) : Number.MAX_SAFE_INTEGER;
    if (prev !== idx) {
      updates.push({ id: item.id, sortOrder: idx });
    }
  });

  return updates;
}
