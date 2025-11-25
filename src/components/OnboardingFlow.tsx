import React, { useState } from 'react';
import appLogo from '../assets/gossip_face.svg';
import { PrivacyGraphic } from './ui/PrivacyGraphic';
import Button from './ui/Button';

// Icon components
const LightningIcon: React.FC<{ className?: string }> = ({
  className = 'w-5 h-5',
}) => (
  <svg
    className={className}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M13 10V3L4 14h7v7l9-11h-7z"
    />
  </svg>
);

const ArrowRightIcon: React.FC<{ className?: string }> = ({
  className = 'w-4 h-4',
}) => (
  <svg
    className={className}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M9 5l7 7-7 7"
    />
  </svg>
);

interface OnboardingFlowProps {
  onComplete: () => void;
  onImportMnemonic?: () => void;
}

const OnboardingFlow: React.FC<OnboardingFlowProps> = ({
  onComplete,
  onImportMnemonic,
}) => {
  const [currentStep, setCurrentStep] = useState(0);

  const steps = [
    {
      title: 'Welcome to Gossip!',
      description:
        'Your private messenger designed for secure, end-to-end encrypted conversations. Connect with confidence.',
      image: appLogo,
    },
    {
      title: 'Privacy by Design 🔒',
      description:
        'All your messages are encrypted and stored locally on your device. Your conversations stay private, always.',
      image: appLogo,
    },
    {
      title: "Let's Get Started! 🚀",
      description:
        'Create your account in seconds and start connecting with people securely.',
      image: appLogo,
    },
  ];

  const nextStep = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      onComplete();
    }
  };

  const prevStep = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  return (
    <div className="h-full p-4 md:p-8 py-14 w-full mx-auto flex flex-col justify-center items-center">
      {/* Content */}
      <div className="flex-1 flex flex-col justify-around text-center ">
        {/* Progress indicator */}
        <div className="flex justify-center shrink-0">
          <div className="flex space-x-2">
            {steps.map((_, index) => (
              <div
                key={index}
                className={`transition-all duration-300 ${
                  index === currentStep
                    ? 'w-8 h-2 bg-primary rounded-full shadow-sm'
                    : 'w-2 h-2 rounded-full bg-muted'
                }`}
              />
            ))}
          </div>
        </div>
        <PrivacyGraphic size={200} />
        <div className="">
          <h1 className="text-3xl md:text-4xl font-bold text-foreground mb-4 leading-tight">
            {currentStep === 0 ? (
              <>
                Welcome to{' '}
                <span className="text-primary text-4xl">Gossip!</span>
              </>
            ) : (
              steps[currentStep].title
            )}
          </h1>
          <p className="text-base md:text-lg text-muted-foreground leading-relaxed max-w-md mx-auto px-2">
            {steps[currentStep].description}
          </p>
        </div>

        {/* Actions: CTAs or Navigation */}
        <div className="shrink-0">
          {/* Create Your Account CTAs */}
          {currentStep === steps.length - 1 && (
            <div className="space-y-4">
              <Button
                onClick={onComplete}
                variant="primary"
                size="custom"
                fullWidth
                className="h-14 text-base font-semibold rounded-2xl gap-2"
              >
                <LightningIcon />
                Create New Account
              </Button>
              {onImportMnemonic && (
                <Button
                  onClick={onImportMnemonic}
                  variant="outline"
                  size="custom"
                  fullWidth
                  className="h-14 text-base font-medium rounded-2xl"
                >
                  Import from Mnemonic
                </Button>
              )}
            </div>
          )}

          {/* Navigation */}
          {currentStep < steps.length - 1 && (
            <div className="flex justify-between items-center">
              {currentStep > 0 ? (
                <Button onClick={prevStep} variant="ghost" size="md">
                  Back
                </Button>
              ) : (
                <div /> // Spacer to keep Next button aligned
              )}

              <Button
                onClick={nextStep}
                variant="primary"
                size="md"
                className="px-8 gap-2"
              >
                {currentStep === steps.length - 2 ? 'Get Started' : 'Next'}
                <ArrowRightIcon />
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default OnboardingFlow;
