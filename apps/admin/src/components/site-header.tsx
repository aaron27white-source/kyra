import { useEffect, useState, type RefObject } from "react";
import { AudioLines, PanelLeftIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

type SiteHeaderProps = React.HTMLAttributes<HTMLElement> & {
  fixed?: boolean;
  className?: string;
  scrollContainerRef?: RefObject<HTMLElement | null>;
  links?: Array<{
    title: string;
    href: string;
    disabled?: boolean;
  }>;
};

export function SiteHeader({
  className,
  fixed,
  scrollContainerRef,
  ...props
}: SiteHeaderProps) {
  const { t } = useTranslation("common");
  const { toggleSidebar } = useSidebar();
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const scrollContainer = scrollContainerRef?.current;
    const onScroll = () => {
      setOffset(
        scrollContainer
          ? scrollContainer.scrollTop
          : document.body.scrollTop || document.documentElement.scrollTop,
      );
    };

    onScroll();
    if (scrollContainer) {
      scrollContainer.addEventListener("scroll", onScroll, { passive: true });
      return () => scrollContainer.removeEventListener("scroll", onScroll);
    }

    document.addEventListener("scroll", onScroll, { passive: true });
    return () => document.removeEventListener("scroll", onScroll);
  }, [scrollContainerRef]);

  return (
    <header
      className={cn(
        "z-50 h-16 md:hidden",
        fixed && "header-fixed peer/header sticky top-0 w-[inherit]",
        offset > 10 && fixed ? "shadow" : "shadow-none",
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          "relative flex h-full items-center gap-3 p-4 sm:gap-4",
          offset > 10 &&
            fixed &&
            "after:absolute after:inset-0 after:-z-10 after:bg-background/20 after:backdrop-blur-lg",
        )}
      >
        <Button
          aria-label="Toggle sidebar"
          className="md:hidden"
          onClick={() => {
            toggleSidebar();
          }}
          size="icon"
          type="button"
          variant="outline"
        >
          <PanelLeftIcon />
        </Button>
        <div className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground"><AudioLines className="size-4" /></span>
          <span className="truncate text-sm font-semibold tracking-tight text-foreground">{t("appName")}</span>
        </div>
      </div>
    </header>
  );
}
