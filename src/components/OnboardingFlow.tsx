import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Zap } from 'react-feather';
import appLogo from '../assets/gossip_face.svg';
import { PrivacyGraphic, LockGraphic, GroupChatGraphic } from './graphics';
import Button from './ui/Button';

interface OnboardingFlowProps {
  onComplete: () => void;
  onImportMnemonic?: () => void;
}

const OnboardingFlow: React.FC<OnboardingFlowProps> = ({
  onComplete,
  onImportMnemonic,
}) => {
  const { t } = useTranslation('onboarding');
  const [currentStep, setCurrentStep] = useState(0);

  const steps = [
    {
      title: t('welcome.title'),
      description: t('welcome.description'),
      image: appLogo,
    },
    {
      title: t('privacy.title'),
      description: t('privacy.description'),
      image: appLogo,
    },
    {
      title: t('get_started.title'),
      description: t('get_started.description'),
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
        {currentStep === 0 ? (
          <PrivacyGraphic size={250} />
        ) : currentStep === 1 ? (
          <LockGraphic size={200} />
        ) : (
          <GroupChatGraphic size={200} />
        )}
        <div className="">
          <h1 className="text-3xl md:text-4xl font-bold text-foreground mb-4 leading-tight">
            {steps[currentStep].title}
          </h1>
          <p className="text-base md:text-lg text-muted-foreground leading-relaxed app-max-w mx-auto px-2">
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
                className="h-14 text-base font-semibold rounded-full gap-2"
              >
                <Zap />
                {t('create_account')}
              </Button>
              {onImportMnemonic && (
                <Button
                  onClick={onImportMnemonic}
                  variant="outline"
                  size="custom"
                  fullWidth
                  className="h-14 text-base font-medium rounded-full"
                >
                  {t('import_mnemonic')}
                </Button>
              )}
            </div>
          )}

          {/* Navigation */}
          {currentStep < steps.length - 1 && (
            <div className="flex justify-between items-center">
              {currentStep > 0 ? (
                <Button onClick={prevStep} variant="ghost" size="md">
                  {t('back')}
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
                {currentStep === steps.length - 2
                  ? t('get_started_button')
                  : t('next')}
                <ArrowRight />
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default OnboardingFlow;
