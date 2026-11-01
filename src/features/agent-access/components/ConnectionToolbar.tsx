"use client";
import { useLang } from "@/components/providers/LanguageProvider";
import type { Device } from "@/shared/contracts/devices";
import { filtersActive, NO_FILTERS, type ConnectionFilters, type ConnectionGroupBy, type Issuer, type StatusFilter } from "@/features/agent-access/connection-view";

type Props = {
  filters: ConnectionFilters; onFilters: (filters: ConnectionFilters) => void;
  issuers: readonly Issuer[]; devices: readonly Device[];
  groupBy: ConnectionGroupBy; onGroupBy: (groupBy: ConnectionGroupBy) => void;
  /** A short list shows only the grouping switch. */
  showFilters: boolean;
};
const STATUSES: readonly StatusFilter[] = ["all", "attention", "pending", "unused", "active", "idle"];
const GROUPINGS: readonly ConnectionGroupBy[] = ["member", "device", "client"];

export default function ConnectionToolbar({ filters, onFilters, issuers, devices, groupBy, onGroupBy, showFilters }: Props) {
  const { t } = useLang();
  const set = (patch: Partial<ConnectionFilters>) => onFilters({ ...filters, ...patch });
  const statusLabel = (status: StatusFilter) => status === "all" ? t.connFilterAll : status === "attention" ? t.connFilterAttention : t.connStatus[status];
  return <div className="conn-toolbar">
    {showFilters && <>
      <input type="search" className="conn-search" aria-label={t.connSearch} placeholder={t.connSearchPh} value={filters.query} maxLength={80}
        onChange={event => set({ query: event.target.value })} />
      {issuers.length > 1 && <label className="conn-filter">{t.connFilterIssuer}
        <select value={filters.issuer} onChange={event => set({ issuer: event.target.value })}>
          <option value="all">{t.connFilterAll}</option><option value="mine">{t.connFilterMine}</option>
          {issuers.filter(issuer => !issuer.viewer).map(issuer => <option key={issuer.ref} value={issuer.ref}>{issuer.name ?? t.issuerUnknown}</option>)}
        </select></label>}
      <label className="conn-filter">{t.connFilterDevice}
        <select value={filters.device} onChange={event => set({ device: event.target.value })}>
          <option value="all">{t.connFilterAll}</option>
          {devices.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}
          <option value="none">{t.connectionUnbound}</option>
        </select></label>
      <label className="conn-filter">{t.connFilterStatus}
        <select value={filters.status} onChange={event => set({ status: event.target.value as StatusFilter })}>
          {STATUSES.map(status => <option key={status} value={status}>{statusLabel(status)}</option>)}
        </select></label>
    </>}
    <div className="conn-segment" role="group" aria-label={t.connGroupBy}>
      {GROUPINGS.map(option => <button key={option} type="button" aria-pressed={groupBy === option} onClick={() => onGroupBy(option)}>
        {option === "member" ? t.connGroupMember : option === "device" ? t.connGroupDevice : t.connGroupClient}</button>)}
    </div>
    {filtersActive(filters) && <button type="button" className="btn quiet small" onClick={() => onFilters(NO_FILTERS)}>{t.connClearFilters}</button>}
  </div>;
}
