/**
 * The heading of a wizard step: "Step 2 of 4" above the step's h2. The h2 takes the focus when the
 * step changes (tabIndex -1, see OnboardingWizard), so keyboard and screen-reader users land on the
 * new step instead of on a button that no longer exists.
 */
import { cn } from '@/lib/utils';
import { WIZARD_STEPS, type WizardStep } from './wizard-model';

export interface StepHeadingProps {
  step: WizardStep;
  title: React.ReactNode;
  description?: React.ReactNode;
  headingRef?: React.Ref<HTMLHeadingElement>;
  className?: string;
}

export function StepHeading({ step, title, description, headingRef, className }: StepHeadingProps) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Step {step} of {WIZARD_STEPS.length}
      </p>
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="text-lg font-semibold tracking-tight text-balance outline-none"
      >
        {title}
      </h2>
      {description && <p className="text-sm text-pretty text-muted-foreground">{description}</p>}
    </div>
  );
}
