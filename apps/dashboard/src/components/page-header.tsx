interface PageHeaderProps {
  title: string;
  subtitle?: string;
  breadcrumbs?: { label: string; href?: string }[];
  actions?: React.ReactNode;
}

export function PageHeader({ title, subtitle, breadcrumbs, actions }: PageHeaderProps) {
  return (
    <div className="mb-6">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav className="mb-2 text-sm text-gray-text">
          {breadcrumbs.map((crumb, i) => (
            <span key={crumb.label}>
              {i > 0 && <span className="mx-1.5">&gt;</span>}
              {crumb.href ? (
                <a href={crumb.href} className="hover:text-orange">
                  {crumb.label}
                </a>
              ) : (
                <span className="text-navy">{crumb.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-navy">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-gray-text">{subtitle}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
