/**
 * The pairing wizard, "Add device" (handoff §6.3, §12): a server shell around the client
 * OnboardingWizard, which gets the code lifetime, the minimum plugin version and the hub's URL from
 * the config, the server's limits (active codes per user, label length) from @hub/server, and the
 * code to resume after a reload from `?code=<id>` (the wizard keeps it there).
 * The wizard's live status comes from the (app) layout's LiveProvider.
 */
import { getConfig } from '@hub/core';
import { DEVICE_LABEL_MAX, MAX_ACTIVE_PAIRING_CODES } from '@hub/server';
import type { Metadata } from 'next';
import { OnboardingWizard } from '@/components/onboarding/onboarding-wizard';
import { RESUME_PARAM, parseResumeParam } from '@/components/onboarding/wizard-model';
import { PageHeader } from '@/components/shell/page-header';
import { requireUser } from '@/lib/session';

export function generateMetadata(): Metadata {
  return { title: `Add a device · ${getConfig().hubName}` };
}

export default async function OnboardingPage({ searchParams }: PageProps<'/onboarding'>) {
  await requireUser();
  const { hubName, pairingCodeTtlSeconds, minPluginVersion, appOrigin } = getConfig();
  const resumeCodeId = parseResumeParam((await searchParams)[RESUME_PARAM]);
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <PageHeader
        title="Add a device"
        description={`Connect the HA Exporter RuneLite plugin to ${hubName}. It takes about two minutes.`}
      />
      <OnboardingWizard
        ttlSeconds={pairingCodeTtlSeconds}
        maxActiveCodes={MAX_ACTIVE_PAIRING_CODES}
        labelMax={DEVICE_LABEL_MAX}
        minPluginVersion={minPluginVersion}
        baseUrl={appOrigin}
        resumeCodeId={resumeCodeId}
      />
    </div>
  );
}
