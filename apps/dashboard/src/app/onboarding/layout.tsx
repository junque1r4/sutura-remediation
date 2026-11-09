export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 bg-cream">
      <div className="mx-auto max-w-2xl px-6 py-12">{children}</div>
    </div>
  );
}
