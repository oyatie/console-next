// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { GroupsConsole } from "./groups-console";
import { OperatorsConsole } from "./operators-console";
import { PlatformTabs, type PlatformTab } from "./platform-tabs";
import { SupportConsole } from "./support-console";
import { TenantsConsole } from "./tenants-console";

export function PlatformConsole() {
  const [tab, setTab] = useState<PlatformTab>("tenants");
  const [supportOrgId, setSupportOrgId] = useState<string>();

  const tabs = <PlatformTabs tab={tab} onSelect={setTab} />;

  if (tab === "groups") return <GroupsConsole tabs={tabs} />;
  if (tab === "operators") return <OperatorsConsole tabs={tabs} />;
  if (tab === "support") return <SupportConsole tabs={tabs} initialOrgId={supportOrgId} />;
  return (
    <TenantsConsole
      tabs={tabs}
      onOpenSupport={(orgId) => {
        setSupportOrgId(orgId);
        setTab("support");
      }}
    />
  );
}
