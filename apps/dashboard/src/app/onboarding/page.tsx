'use client';

import { useState } from 'react';

const STEPS = ['Connect Scanner', 'Select Repositories', 'Custom Prompts', 'Review & Start'];

function StepConnectScanner() {
  const [selected, setSelected] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');

  const scanners = ['Aikido', 'Snyk', 'GitHub Dependabot'];

  return (
    <div className="space-y-6">
      <p className="text-gray-text text-sm">
        Choose your security scanner and connect it with an API key.
      </p>
      <div className="flex gap-3">
        {scanners.map((scanner) => (
          <button
            key={scanner}
            onClick={() => setSelected(scanner)}
            className={`flex-1 rounded-lg border px-4 py-3 text-sm font-medium transition-colors ${
              selected === scanner
                ? 'border-orange bg-orange text-white'
                : 'border-border bg-white text-navy hover:border-orange'
            }`}
          >
            {scanner}
          </button>
        ))}
      </div>
      <div className="space-y-2">
        <label className="text-navy block text-sm font-medium">API Key</label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="Enter your API key"
          className="border-border text-navy w-full rounded-lg border bg-white px-4 py-2.5 text-sm placeholder-gray-muted focus:border-orange focus:outline-none"
        />
      </div>
      <button className="rounded-lg border border-orange px-4 py-2 text-sm font-medium text-orange transition-colors hover:bg-orange hover:text-white">
        Test Connection
      </button>
    </div>
  );
}

function StepSelectRepos() {
  const repos = [
    'acme-corp/frontend',
    'acme-corp/backend-api',
    'acme-corp/mobile-app',
    'acme-corp/infra-configs',
  ];
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const toggle = (repo: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(repo)) {
        next.delete(repo);
      } else {
        next.add(repo);
      }
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <p className="text-gray-text text-sm">
        Select the repositories you&apos;d like Sutura to index and monitor.
      </p>
      <div className="space-y-3">
        {repos.map((repo) => (
          <label
            key={repo}
            className="border-border flex cursor-pointer items-center gap-3 rounded-lg border bg-white px-4 py-3 transition-colors hover:border-orange"
          >
            <input
              type="checkbox"
              checked={checked.has(repo)}
              onChange={() => toggle(repo)}
              className="h-4 w-4 accent-orange"
            />
            <span className="text-navy text-sm font-medium">{repo}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function StepCustomPrompts() {
  const [env, setEnv] = useState('');
  const [testing, setTesting] = useState('');
  const [conventions, setConventions] = useState('');

  const fields = [
    {
      label: 'Environment Setup',
      value: env,
      setter: setEnv,
      placeholder: 'Describe your environment setup...',
    },
    {
      label: 'Testing Instructions',
      value: testing,
      setter: setTesting,
      placeholder: 'Describe your testing approach...',
    },
    {
      label: 'Code Conventions',
      value: conventions,
      setter: setConventions,
      placeholder: 'Describe your code conventions...',
    },
  ];

  return (
    <div className="space-y-6">
      <p className="text-gray-text text-sm">
        Provide context so Sutura&apos;s AI can give you more accurate, actionable fixes.
      </p>
      <div className="space-y-5">
        {fields.map(({ label, value, setter, placeholder }) => (
          <div key={label} className="space-y-2">
            <label className="text-navy block text-sm font-medium">{label}</label>
            <textarea
              value={value}
              onChange={(e) => setter(e.target.value)}
              placeholder={placeholder}
              rows={3}
              className="border-border text-navy w-full resize-none rounded-lg border bg-white px-4 py-2.5 text-sm placeholder-gray-muted focus:border-orange focus:outline-none"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function StepReview() {
  const summaryCards = [
    {
      title: 'Scanner',
      value: 'Snyk',
      description: 'Connected via API key',
    },
    {
      title: 'Repositories',
      value: '4 selected',
      description: 'acme-corp/frontend and 3 more',
    },
    {
      title: 'Custom Prompts',
      value: '3 configured',
      description: 'Environment, Testing, Conventions',
    },
  ];

  return (
    <div className="space-y-6">
      <p className="text-gray-text text-sm">
        Everything looks good. Review your configuration and start indexing.
      </p>
      <div className="space-y-3">
        {summaryCards.map((card) => (
          <div
            key={card.title}
            className="border-border flex items-start gap-4 rounded-lg border bg-white px-4 py-3"
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-orange/10">
              <span className="text-xs font-bold text-orange">{card.title[0]}</span>
            </div>
            <div>
              <p className="text-navy text-sm font-semibold">{card.title}</p>
              <p className="text-navy text-sm">{card.value}</p>
              <p className="text-gray-text text-xs">{card.description}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function OnboardingPage() {
  const [currentStep, setCurrentStep] = useState(0);

  const stepComponents = [
    <StepConnectScanner key="connect" />,
    <StepSelectRepos key="repos" />,
    <StepCustomPrompts key="prompts" />,
    <StepReview key="review" />,
  ];

  const isFirst = currentStep === 0;
  const isLast = currentStep === STEPS.length - 1;
  const canSkip = currentStep === 1 || currentStep === 2;

  return (
    <div className="space-y-8">
      {/* Logo */}
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-orange">
          <span className="text-sm font-bold text-white">S</span>
        </div>
        <span className="text-navy text-lg font-semibold">Sutura</span>
      </div>

      {/* Progress bar */}
      <div className="flex items-center">
        {STEPS.map((step, index) => (
          <div key={step} className="flex flex-1 items-center">
            <div className="relative flex flex-col items-center">
              <div
                className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold transition-colors ${
                  index <= currentStep
                    ? 'bg-orange text-white'
                    : 'border-border border-2 bg-white text-gray-muted'
                }`}
              >
                {index + 1}
              </div>
            </div>
            {index < STEPS.length - 1 && (
              <div
                className={`h-0.5 flex-1 transition-colors ${
                  index < currentStep ? 'bg-orange' : 'bg-border'
                }`}
              />
            )}
          </div>
        ))}
      </div>

      {/* Step title */}
      <div>
        <p className="text-gray-text text-xs font-medium uppercase tracking-wider">
          Step {currentStep + 1} of {STEPS.length}
        </p>
        <h1 className="text-navy mt-1 text-2xl font-bold">{STEPS[currentStep]}</h1>
      </div>

      {/* Step content */}
      <div>{stepComponents[currentStep]}</div>

      {/* Navigation */}
      <div className="flex items-center justify-between pt-2">
        <button
          onClick={() => setCurrentStep((s) => s - 1)}
          disabled={isFirst}
          className="rounded-lg border border-border px-5 py-2 text-sm font-medium text-navy transition-colors hover:border-orange disabled:cursor-not-allowed disabled:opacity-40"
        >
          Back
        </button>

        <div className="flex items-center gap-3">
          {canSkip && (
            <button
              onClick={() => setCurrentStep((s) => s + 1)}
              className="text-sm font-medium text-gray-text hover:text-navy"
            >
              Skip
            </button>
          )}

          {isLast ? (
            <a
              href="/"
              className="rounded-lg bg-orange px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-orange-deep"
            >
              Start Indexing
            </a>
          ) : (
            <button
              onClick={() => setCurrentStep((s) => s + 1)}
              className="rounded-lg bg-orange px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-orange-deep"
            >
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
