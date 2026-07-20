import { describe, expect, it } from 'vitest';
import { buildVisibleRouteList, type RouteListVisibilityItem } from './routeListVisibility.js';

function isExactModelPattern(pattern: string): boolean {
  const normalized = (pattern || '').trim();
  return !!normalized && !normalized.includes('*') && !normalized.startsWith('re:');
}

function matchesModelPattern(model: string, pattern: string): boolean {
  const normalized = (pattern || '').trim();
  if (!normalized) return false;
  if (normalized === '*') return true;
  if (normalized.startsWith('re:')) {
    return new RegExp(normalized.slice(3)).test(model);
  }
  if (normalized.endsWith('*')) {
    return model.startsWith(normalized.slice(0, -1));
  }
  return model === normalized;
}

function buildRoute(partial: Partial<RouteListVisibilityItem> & Pick<RouteListVisibilityItem, 'id' | 'modelPattern'>): RouteListVisibilityItem {
  return {
    displayName: partial.displayName ?? null,
    routeMode: partial.routeMode ?? 'pattern',
    sourceRouteIds: partial.sourceRouteIds ?? [],
    enabled: partial.enabled ?? true,
    ...partial,
  };
}

describe('buildVisibleRouteList', () => {
  it('keeps a single-source exact route visible when covered by an explicit group', () => {
    const routes = [
      buildRoute({
        id: 11,
        modelPattern: 'claude-haiku-4-5-20251001',
        displayName: 'claude-haiku-4-5-20251001',
      }),
      buildRoute({
        id: 21,
        modelPattern: 'claude-haiku-proxy',
        displayName: 'claude-haiku-proxy',
        routeMode: 'explicit_group',
        sourceRouteIds: [11],
      }),
    ];

    const visible = buildVisibleRouteList(routes, isExactModelPattern, matchesModelPattern);
    expect(visible.map((route) => route.id)).toEqual([11, 21]);
  });

  it('hides exact routes covered by a multi-source explicit group', () => {
    const routes = [
      buildRoute({
        id: 11,
        modelPattern: 'claude-haiku-4-5-20251001',
      }),
      buildRoute({
        id: 12,
        modelPattern: 'claude-haiku-4-5',
      }),
      buildRoute({
        id: 21,
        modelPattern: 'claude-haiku-proxy',
        displayName: 'claude-haiku-proxy',
        routeMode: 'explicit_group',
        sourceRouteIds: [11, 12],
      }),
    ];

    const visible = buildVisibleRouteList(routes, isExactModelPattern, matchesModelPattern);
    expect(visible.map((route) => route.id)).toEqual([21]);
  });

  it('still hides exact routes covered by a named pattern group', () => {
    const routes = [
      buildRoute({
        id: 1,
        modelPattern: 'minimax-m2.1',
      }),
      buildRoute({
        id: 2,
        modelPattern: 'minimaxai/minimax-m2.1',
      }),
      buildRoute({
        id: 3,
        modelPattern: 're:^(minimax-m2\\.1|minimaxai/minimax-m2\\.1)$',
        displayName: 'minimax2.1',
      }),
    ];

    const visible = buildVisibleRouteList(routes, isExactModelPattern, matchesModelPattern);
    expect(visible.map((route) => route.id)).toEqual([3]);
  });
});
