/**
 * The pairing wizard, "Add device" (handoff §6.3, §12): a server shell around the client
 * OnboardingWizard, which gets the code lifetime and the minimum plugin version from the config. The
 * wizard's live status comes from the (app) layout's LiveProvider.
 */
import { getConfig } from '@hub/core';
import type { Metadata } from 'next';
import { OnboardingWizard } from '@/components/onboarding/onboarding-wizard';
import { PageHeader } from '@/components/shell/page-header';
import { requireUser } from '@/lib/session';

export function generateMetadata(): Metadata {
  return { title: `Add a device · ${getConfig().hubName}` };
}

export default async function OnboardingPage() {
  await requireUser();
  const { hubName, pairingCodeTtlSeconds, minPluginVersion } = getConfig();
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <PageHeader
        title="Add a device"
        description={`Connect the HA Exporter RuneLite plugin to ${hubName}. It takes about two minutes.`}
      />
      <OnboardingWizard ttlSeconds={pairingCodeTtlSeconds} minPluginVersion={minPluginVersion} />
    </div>
  );
}
