import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";
import MembersTab from "@/features/org/MembersTab";
import AgentsTab from "@/features/org/AgentsTab";
import TokensTab from "@/features/org/TokensTab";
import IntegrationsTab from "@/features/org/IntegrationsTab";
import ApiTab from "@/features/org/ApiTab";
import BillingTab from "@/features/org/BillingTab";
import ImportTab from "@/features/org/ImportTab";
import SecurityTab from "@/features/org/SecurityTab";
import AuditTab from "@/features/org/AuditTab";
import DataTab from "@/features/org/DataTab";
import { useMe } from "@/hooks/use-me";

const NUMERALS = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii"] as const;

const TABS = [
  { to: "/org", label: "Members" },
  { to: "/org/agents", label: "Agents" },
  { to: "/org/tokens", label: "Tokens" },
  { to: "/org/integrations", label: "Integrations" },
  { to: "/org/api", label: "API" },
  { to: "/org/import", label: "Import" },
] as const;
// Billing only exists on the hosted instance; self-hosted organizations never see it.
const BILLING_TAB = { to: "/org/billing", label: "Billing" } as const;
// Security, then its record, then the data itself: enrol, read what happened, leave
// or take everything with you.
const ACCOUNT_TABS = [
  { to: "/org/security", label: "Security" },
  { to: "/org/audit", label: "Audit" },
  { to: "/org/data", label: "Data" },
] as const;

/**
 * Org — who is in the organization, what credentials exist, and what the outside
 * world may talk to. Humans and agents share one roll on purpose: an agent is a
 * member with a token, not a separate kind of account.
 */
export default function Org() {
  const location = useLocation();
  const { org } = useMe();
  // The numeral is the tab's position, not a fixed label: Billing is absent on a
  // self-hosted deployment, and the ones after it must still read i…ix in order.
  const tabs = (org && org.plan !== "self_hosted" ? [...TABS, BILLING_TAB, ...ACCOUNT_TABS] : [...TABS, ...ACCOUNT_TABS]).map(
    (tab, index) => ({ ...tab, num: NUMERALS[index] ?? String(index + 1) }),
  );

  return (
    <section className="animate-ink-fade-in space-y-5">
      <div>
        <div className="eyebrow">
          <span className="text-vermilion">§ IV.</span> The Roll
        </div>
        <h2 className="font-display text-2xl sm:text-4xl font-normal tracking-tight mt-1">
          Who may <span className="italic">write</span> here
        </h2>
      </div>

      <nav className="rule-b">
        <ul className="flex gap-1 -mx-1 overflow-x-auto nice-scroll">
          {tabs.map((t) => {
            const active = t.to === "/org" ? location.pathname === "/org" || location.pathname === "/org/" : location.pathname.startsWith(t.to);
            return (
              <li key={t.to}>
                <Link
                  to={t.to}
                  className={cn("relative block px-3 py-2 focus-ink rounded-sm whitespace-nowrap", active ? "text-ink" : "text-ink-muted hover:text-ink")}
                  data-testid={`org-tab-${t.label.toLowerCase()}`}
                >
                  <span className="flex items-baseline gap-2">
                    <span className="section-num">{t.num}.</span>
                    <span className="font-display text-base tracking-tight">{t.label}</span>
                  </span>
                  {active ? <span className="absolute left-0 right-0 -bottom-px h-[2px] bg-vermilion" /> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <Routes>
        <Route index element={<MembersTab />} />
        <Route path="agents" element={<AgentsTab />} />
        <Route path="tokens" element={<TokensTab />} />
        <Route path="integrations" element={<IntegrationsTab />} />
        <Route path="api" element={<ApiTab />} />
        <Route path="import" element={<ImportTab />} />
        <Route path="billing" element={<BillingTab />} />
        <Route path="security" element={<SecurityTab />} />
        <Route path="audit" element={<AuditTab />} />
        <Route path="data" element={<DataTab />} />
        <Route path="*" element={<Navigate to="/org" replace />} />
      </Routes>
    </section>
  );
}
