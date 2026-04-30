import {
  useLoaderData,
  Link,
  useFetcher,
  useNavigate,
  type ActionFunctionArgs,
  type HeadersFunction
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import  { useEffect, useState } from "react";
import prisma from "app/db.server";
import { authenticate } from "app/shopify.server";
import { LoaderFunctionArgs } from "react-router";
import { syncShopifyCompanies } from "app/utils/company.server";


type CompletedStepsState = {
  step1: boolean;
  step2: boolean;
  step3: boolean;
};
 
type Tutorial = {
  id: number;
  tag: string;
  tagClass: string;
  title: string;
  description: string;
  videoUrl: string;
  duration: string;
  thumbnailTitle: string;
};

type ActionResponse = {
  intent: string;
  success: boolean;
  message?: string;
  errors?: string[];
};

type ThemeSummary = {
  name: string;
  role: string;
  gid: string;
  numericId: string | undefined;
};

const hasReadThemesScopeError = (error: unknown) => {
  if (!error || typeof error !== "object") {
    return false;
  }

  const graphQLErrors = (error as {
    body?: {
      errors?: {
        graphQLErrors?: Array<{ message?: string }>;
      };
    };
  }).body?.errors?.graphQLErrors;

  return (graphQLErrors ?? []).some((graphQLError) =>
    graphQLError.message?.includes("read_themes"),
  );
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  let themes: ThemeSummary[] = [];
  let missingScope = false;

  try {
    const response = await admin.graphql(
      `#graphql
      {
        themes(first: 10) {
          nodes {
            id
            name
            role
          }
        }
      }`
    );

    const { data } = await response.json();

    themes = (data?.themes?.nodes ?? []).map((theme: { id: string; name: string; role: string }) => ({
      name: theme.name,
      role: theme.role,
      gid: theme.id,
      numericId: theme.id.split("/").pop(),
    }));
    
  } catch (error) {
    if (hasReadThemesScopeError(error)) {
      missingScope = true;
      console.warn("Skipping theme load on app index because read_themes is not granted for this shop.");
    } else {
      console.error("Unable to load themes for app index", error);
    }
  }

  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop }, 
  });

  if (!store) {
    return Response.json(
      { submissions: [], storeMissing: true, themes: [] },
      { status: 404 },
    );
  }


  return Response.json({
    themes,
    missingScope,
    store,
    completedSetupSteps: store.completedSetupSteps || [],
    setupFinished: store.setupFinished
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "markStepComplete") {
    const label = String(formData.get("label") || "");
    const store = await prisma.store.findUnique({
      where: { shopDomain: session.shop },
      select: { id: true, completedSetupSteps: true }
    });

    if (!store) return Response.json({ success: false, error: "Store not found" });

    const currentSteps = (store.completedSetupSteps as string[]) || [];
    if (!currentSteps.includes(label)) {
      await prisma.store.update({
        where: { id: store.id },
        data: {
          completedSetupSteps: [...currentSteps, label]
        }
      });
    }

    return Response.json({ success: true });
  }

  if (intent === "finishSetup") {
    await prisma.store.update({
      where: { shopDomain: session.shop },
      data: { setupFinished: true }
    });
    return Response.json({ success: true });
  }

  if (intent !== "syncCompanies") {
    return Response.json({
      intent,
      success: false,
      errors: ["Unknown intent"],
    });
  }

  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
    select: {
      id: true,
      shopDomain: true,
      shopName: true,
      storeOwnerName: true,
      contactEmail: true,
      submissionEmail: true,
    },
  });

  if (!store) {
    return Response.json({
      intent,
      success: false,
      errors: ["Store not found"],
    }, { status: 404 });
  }

  const result = await syncShopifyCompanies(
    admin,
    store,
    store.contactEmail || store.submissionEmail,
  );

  return Response.json({
    intent,
    success: result.success,
    message: result.message,
    errors: result.errors,
  });
};

export default function Welcome() {
  const { store, themes = [], completedSetupSteps = [], setupFinished = false } = useLoaderData<typeof loader>() as {
    themes: ThemeSummary[];
    store: { shopDomain: string; id: string } | null;
    completedSetupSteps: string[];
    setupFinished: boolean;
  };
  const syncFetcher = useFetcher<ActionResponse>();
  const setupFetcher = useFetcher();
  const navigate = useNavigate();
  const [isGuideCollapsed, setIsGuideCollapsed] = useState(false);
  const [showSetupEssentials, setShowSetupEssentials] = useState(!setupFinished);


  const [completedSteps, setCompletedSteps] = useState({
    step1: false,
    step2: false,
    step3: false
  });

  const toggleStep = (step: keyof CompletedStepsState) => {
    setCompletedSteps(prev => ({
      ...prev,
      [step]: !prev[step]
    }));
  };

   const getStoreName = () => {
    if (!store?.shopDomain) return '';
    return store.shopDomain.split('.')[0];
  };

  const mainTheme = themes.find((theme) => theme.role === "MAIN");
  const themeAdminHref = mainTheme?.numericId
    ? `https://admin.shopify.com/store/${getStoreName()}/themes/${mainTheme.numericId}/editor`
    : `https://admin.shopify.com/store/${getStoreName()}/themes`;



  const [selectedTutorial, setSelectedTutorial] = useState<Tutorial | null>(null);
  const setupEssentials = [
    {
      label: "Customize the application form",
      actionLabel: "View form editor",
      href: "/app/registration-form",
    },
    {
      label: "Review approval preset",
      actionLabel: "Manage preset",
      href: "/app/settings",
    },
    {
      label: "Activate app extensions",
      actionLabel: "Manage installation",
      href: themeAdminHref,
      external: true,
    },
    {
      label: "Configure email notifications",
      actionLabel: "Manage notifications",
      href: "/app/notifications",
    },
  ];
  const tutorials = [
    {
      id: 1,
      tag: "Storefront",
      tagClass: "tag-storefront",
      title: "Enable B2B Registration on Storefront",
      description: "Learn how to enable the app embed and display the B2B company registration form on your storefront so wholesale customers can apply.",
      videoUrl: "https://www.youtube.com/embed/d56mG7DezGs",
      duration: "4:55",
      thumbnailTitle: "How To Set Up\nRequest For Quote?"
    },
    {
      id: 2,
      tag: "Store setup",
      tagClass: "tag-customer",
      title: "Create & Publish B2B Portal Page",
      description: "Step-by-step guide to creating a B2B portal page, adding the app block, and linking it to your store menu.",
      videoUrl: "https://www.youtube.com/embed/d56mG7DezGs",
      duration: "2:58",
      thumbnailTitle: "How To Set Up\nQuick Order?"
    },
    {
      id: 3,
      tag: "Admin workflow",
      tagClass: "tag-customer",
      title: "Approve Companies & Manage Access",
      description: "See how to review B2B registrations, approve companies, manage users, locations, and assign roles.",
      videoUrl: "https://www.youtube.com/embed/d56mG7DezGs",
      duration: "3:42",
      thumbnailTitle: "How To Manage\nCompany Access?"
    }
  ];


  const isSetupItemComplete = (label: string) =>
    completedSetupSteps.includes(label);

  const markSetupItemComplete = (label: string) => {
    if (isSetupItemComplete(label)) return;

    setupFetcher.submit(
      { intent: "markStepComplete", label },
      { method: "post" }
    );
  };

  const areAllSetupItemsComplete =
    setupEssentials.length > 0 &&
    setupEssentials.every((item) => isSetupItemComplete(item.label));

  const handleFinishAndClose = () => {
    if (!areAllSetupItemsComplete) {
      return;
    }

    setupFetcher.submit(
      { intent: "finishSetup" },
      { method: "post" }
    );
    setShowSetupEssentials(false);
  };
  const openModal = (tutorial: Tutorial) => {
    setSelectedTutorial(tutorial);
  };

  const closeModal = () => {
    setSelectedTutorial(null);
  };

  useEffect(() => {
    if (syncFetcher.state === "idle" && syncFetcher.data?.success) {
      navigate("/app/companies");
    }
  }, [navigate, syncFetcher.data, syncFetcher.state]);


  return (
    <div
      style={{
        background: "#f1f2f4",
        minHeight: "100vh",
        padding: "24px",
        fontFamily:
          'var(--p-font-family-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)',
      }}
    >
      <style>{`
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }

        .setup-container {
          max-width: 1200px;
          margin: 0 auto;
        }

        /* Header */
        .setup-header {
          display: flex;
          align-items: center;
          margin-bottom: 24px;
        }

        .setup-header h1 {
          font-size: 24px;
          font-weight: 600;
          color: #303030;
        }

        .help-center-btn {
          background: #e4e5e7;
          border: none;
          padding: 8px 16px;
          border-radius: 6px;
          font-size: 14px;
          font-weight: 500;
          color: #303030;
          cursor: pointer;
          transition: background 0.2s;
        }

        .help-center-btn:hover {
          background: #d4d5d7;
        }

        .status-badge.enabled {
          background-color: #d4edda;
          color: #155724;
        }

        .status-badge.disabled {
          background-color: #f8d7da;
          color: #721c24;
        }

        /* App Embed Status Card */
        .embed-status-card {
          background: white;
          border-radius: 8px;
          padding: 16px 20px;
          margin-bottom: 16px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          border: 1px solid #e4e5e7;
        }

        .embed-status-left {
          flex: 1;
        }

        .embed-status-title {
          font-size: 14px;
          font-weight: 600;
          margin-bottom: 8px;
          color: #303030;
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .status-badge {
          background: #fbefd7;
          color: #916a00;
          padding: 4px 10px;
          border-radius: 4px;
          font-size: 12px;
          font-weight: 500;
        }

        .embed-status-description {
          color: #6d7175;
          font-size: 14px;
        }

        .enable-app-btn {
          background: #303030;
          color: white;
          border: none;
          padding: 10px 20px;
          border-radius: 6px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.2s;
        }

        .enable-app-btn:hover {
          background: #1a1a1a;
        }

        /* Setup Guide Card */
        .setup-guide-card {
          background: white;
          border-radius: 8px;
          padding: 20px;
          margin-bottom: 16px;
          border: 1px solid #e4e5e7;
        }

        .setup-essentials-card {
          background: white;
          border-radius: 16px;
          margin-bottom: 16px;
          border: 1px solid #d8dadd;
          overflow: hidden;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
        }

        .setup-essentials-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 18px 20px;
          border-bottom: 1px solid #eceef1;
          background: #ffffff;
        }

        .setup-essentials-title {
          display: flex;
          align-items: center;
          gap: 10px;
          font-size: 14px;
          font-weight: 600;
          color: #303030;
        }

        .setup-essentials-icon {
          width: 18px;
          height: 18px;
          border-radius: 6px;
          border: 1.5px solid #303030;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 11px;
          line-height: 1;
          color: #303030;
        }

        .setup-essentials-icon.completed {
          border-color: #008060;
          background: #008060;
          color: #ffffff;
        }

        .setup-essentials-close {
          background: transparent;
          border: none;
          color: #6d7175;
          font-size: 22px;
          cursor: pointer;
          line-height: 1;
          padding: 0;
        }

        .setup-essential-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          padding: 18px 20px;
          border-bottom: 1px solid #eceef1;
        }

        .setup-essential-row:last-of-type {
          border-bottom: none;
        }

        .setup-essential-label {
          display: flex;
          align-items: center;
          gap: 12px;
          color: #303030;
          font-size: 14px;
          font-weight: 500;
        }

        .setup-essential-check {
          width: 18px;
          height: 18px;
          border-radius: 50%;
          border: 2px solid #303030;
          color: #303030;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 11px;
          flex-shrink: 0;
          background: #ffffff;
        }

        .setup-essential-check.completed {
          border-color: #008060;
          background: #008060;
          color: #ffffff;
        }

        .setup-essential-link {
          color: #0a61c7;
          font-size: 14px;
          font-weight: 500;
          text-decoration: none;
          white-space: nowrap;
        }

        .setup-essential-link:hover {
          text-decoration: underline;
        }

        .setup-essentials-footer {
          display: flex;
          justify-content: flex-end;
          padding: 18px 20px;
          background: #ffffff;
          border-top: 1px solid #eceef1;
        }

        .setup-essentials-button {
          background: #ffffff;
          border: 1px solid #c9cccf;
          border-radius: 12px;
          padding: 10px 16px;
          color: #303030;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
        }

        .setup-essentials-button:hover {
          background: #f6f6f7;
        }

        .setup-essentials-button:disabled {
          background: #f6f6f7;
          border-color: #e4e5e7;
          color: #8c9196;
          cursor: not-allowed;
        }

        .overview-card {
          background: white;
          border-radius: 16px;
          border: 1px solid #d8dadd;
          margin-bottom: 16px;
          overflow: hidden;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
        }

        .overview-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 14px 18px;
          border-bottom: 1px solid #eceef1;
        }

        .overview-title {
          font-size: 16px;
          font-weight: 600;
          color: #303030;
        }

        .overview-news {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          border: 1px solid #d8dadd;
          border-radius: 10px;
          padding: 8px 12px;
          background: #fff;
          color: #303030;
          font-size: 14px;
          font-weight: 500;
          position: relative;
        }

        .overview-news-dot {
          position: absolute;
          top: 8px;
          right: 8px;
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #e11d48;
        }

        .overview-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 16px;
          padding: 16px;
        }

        .overview-item {
          border: 1px solid #e4e5e7;
          border-radius: 12px;
          padding: 16px 18px;
          min-height: 168px;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
        }

        .overview-item-header {
          display: flex;
          align-items: center;
          gap: 10px;
          font-size: 15px;
          font-weight: 600;
          color: #303030;
          margin-bottom: 16px;
        }

        .overview-icon {
          width: 18px;
          height: 18px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          color: #303030;
          flex-shrink: 0;
        }

        .overview-count {
          font-size: 38px;
          line-height: 1;
          font-weight: 600;
          color: #4a4f55;
          margin-top: 8px;
        }

        .overview-description {
          color: #4a4f55;
          font-size: 14px;
          line-height: 1.6;
          max-width: 420px;
        }

        .overview-button {
          background: white;
          border: 1px solid #c9cccf;
          border-radius: 10px;
          padding: 10px 14px;
          color: #303030;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          width: fit-content;
          text-decoration: none;
        }

        .overview-button:hover {
          background: #f6f6f7;
        }

        .overview-button.disabled {
          background: #f1f2f4;
          border-color: #eceef1;
          color: #a1a5aa;
          cursor: not-allowed;
          pointer-events: none;
        }

        .setup-guide-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 12px;
        }

        .setup-guide-title {
          font-size: 16px;
          font-weight: 600;
          color: #303030;
          margin-bottom: 8px;
        }

        .collapse-btn {
          background: transparent;
          border: none;
          cursor: pointer;
          color: #6d7175;
          font-size: 18px;
          padding: 0;
          transition: transform 0.3s;
        }

        .collapse-btn.collapsed {
          transform: rotate(180deg);
        }

        .setup-guide-description {
          color: #6d7175;
          font-size: 14px;
          margin-bottom: 12px;
        }

        .progress-text {
          color: #6d7175;
          font-size: 14px;
          margin-bottom: 20px;
        }

        /* Setup Steps */
        .setup-step {
          display: flex;
          gap: 16px;
          padding: 16px 0;
          border-top: 1px solid #e4e5e7;
        }

        .setup-step:first-child {
          border-top: none;
        }

        .step-icon {
          width: 32px;
          height: 32px;
          border: 2px solid #c9cccf;
          border-radius: 50%;
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          margin-top: 4px;
        }

        .step-icon-inner {
          width: 12px;
          height: 12px;
          border-radius: 50%;
          background: transparent;
        }

        .step-content {
          flex: 1;
        }

        .step-title {
          font-size: 15px;
          font-weight: 600;
          color: #303030;
          margin-bottom: 8px;
        }

        .step-description {
          color: #6d7175;
          font-size: 14px;
          margin-bottom: 12px;
          line-height: 1.5;
        }

        .create-form-btn {
          background: #303030;
          color: white;
          border: none;
          padding: 8px 16px;
          border-radius: 6px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.2s;
        }

        .create-form-btn:hover {
          background: #1a1a1a;
        }

        .update-badge {
          background: #0a61c7;
          color: white;
          padding: 4px 10px;
          border-radius: 12px;
          font-size: 12px;
          font-weight: 500;
          display: inline-flex;
          align-items: center;
          gap: 4px;
          margin-left: 8px;
        }

        .update-badge::before {
          content: "●";
          font-size: 8px;
        }

        /* Onboarding Call Card */
        .onboarding-card {
          background: white;
          border-radius: 8px;
          padding: 20px;
          margin-bottom: 16px;
          border: 1px solid #e4e5e7;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 20px;
        }

        .onboarding-left {
          flex: 1;
        }

        .onboarding-badge {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          background: #d1fae5;
          color: #008060;
          padding: 4px 12px;
          border-radius: 12px;
          font-size: 12px;
          font-weight: 600;
          margin-bottom: 12px;
        }

        .onboarding-badge::before {
          content: "ⓘ";
          font-size: 14px;
        }

        .onboarding-title {
          font-size: 18px;
          font-weight: 600;
          color: #303030;
          margin-bottom: 12px;
        }

        .onboarding-description {
          color: #6d7175;
          font-size: 14px;
          line-height: 1.5;
          margin-bottom: 16px;
        }

        .onboarding-buttons {
          display: flex;
          gap: 12px;
        }

        .book-call-btn {
          background: #303030;
          color: white;
          border: none;
          padding: 10px 18px;
          border-radius: 6px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.2s;
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .book-call-btn:hover {
          background: #1a1a1a;
        }

        .chat-btn {
          background: white;
          color: #303030;
          border: 1px solid #c9cccf;
          padding: 10px 18px;
          border-radius: 6px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .chat-btn:hover {
          background: #f6f6f7;
          border-color: #8a9099;
        }

        .onboarding-right {
          position: relative;
          width: 180px;
          height: 120px;
          flex-shrink: 0;
        }

        .chat-bubble-container {
          position: relative;
          width: 100%;
          height: 100%;
        }

        .chat-bubble {
          position: absolute;
          padding: 12px 16px;
          border-radius: 12px;
          font-size: 13px;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }

        .chat-bubble-1 {
          background: #e8f2ff;
          color: #0a61c7;
          top: 0;
          right: 0;
          width: 140px;
          height: 40px;
        }

        .chat-bubble-2 {
          background: #4a9cb8;
          color: white;
          bottom: 0;
          right: 20px;
          width: 120px;
          height: 40px;
        }

        /* Tutorials Section */
        .tutorials-section {
          background: white;
          border-radius: 16px;
          padding: 22px;
          border: 1px solid #d8dadd;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
        }

        .tutorials-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 16px;
          margin-bottom: 18px;
        }

        .tutorials-title {
          font-size: 24px;
          font-weight: 700;
          color: #303030;
          margin-bottom: 4px;
        }

        .tutorials-subtitle {
          color: #6d7175;
          font-size: 14px;
          line-height: 1.5;
        }

        .tutorials-menu {
          border: none;
          background: transparent;
          color: #6d7175;
          font-size: 22px;
          line-height: 1;
          cursor: pointer;
          padding: 0;
        }

        .tutorials-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 12px;
        }

        .tutorial-card {
          border: 1px solid #d8dadd;
          border-radius: 12px;
          cursor: pointer;
          overflow: hidden;
          background: #ffffff;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
          transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
        }

        .tutorial-card:hover {
          transform: translateY(-3px);
          box-shadow: 0 12px 24px rgba(31, 33, 36, 0.1);
          border-color: #c9cccf;
        }

        .tutorial-card-visual {
          position: relative;
          min-height: 150px;
          padding: 14px 14px 12px;
          background:
            radial-gradient(circle at top right, rgba(145, 116, 255, 0.45), transparent 34%),
            linear-gradient(135deg, #121033 0%, #1c184e 48%, #28206a 100%);
          display: flex;
          flex-direction: column;
          justify-content: space-between;
        }

        .tutorial-card-visual::after {
          content: "";
          position: absolute;
          inset: 0;
          background: linear-gradient(180deg, rgba(255, 255, 255, 0.02) 0%, rgba(0, 0, 0, 0.18) 100%);
          pointer-events: none;
        }

        .tutorial-card-badge {
          position: relative;
          z-index: 1;
          width: fit-content;
          margin: 0 auto;
          padding: 3px 8px;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.18);
          background: rgba(88, 72, 168, 0.42);
          color: #d7d2ff;
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }

        .tutorial-thumbnail-title {
          position: relative;
          z-index: 1;
          color: #f4f1ff;
          font-size: 20px;
          font-weight: 700;
          line-height: 1.1;
          text-align: center;
          white-space: pre-line;
          margin-top: 12px;
          text-shadow: 0 4px 20px rgba(0, 0, 0, 0.35);
        }

        .tutorial-duration {
          position: absolute;
          left: 12px;
          bottom: 12px;
          z-index: 1;
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 4px 8px;
          border-radius: 8px;
          background: rgba(12, 13, 14, 0.85);
          color: #ffffff;
          font-size: 11px;
          font-weight: 600;
        }

        .tutorial-duration-icon {
          font-size: 10px;
          line-height: 1;
        }

        .tutorial-card-body {
          padding: 12px;
        }

        .tutorial-tag {
          display: inline-block;
          padding: 3px 8px;
          border-radius: 999px;
          font-size: 10px;
          font-weight: 600;
          margin-bottom: 10px;
        }

        .tag-storefront {
          background: #f6f6f7;
          color: #6d7175;
        }

        .tag-customer {
          background: #e0f0ff;
          color: #0a61c7;
        }

        .tutorial-card-title {
          font-size: 14px;
          font-weight: 600;
          color: #303030;
          margin-bottom: 8px;
        }

        .tutorial-card-description {
          color: #6d7175;
          font-size: 12px;
          line-height: 1.4;
          margin-bottom: 12px;
          min-height: 50px;
        }

        .watch-tutorial-btn {
          background: white;
          color: #303030;
          border: 1px solid #c9cccf;
          padding: 7px 12px;
          border-radius: 9px;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
          width: fit-content;
        }

        .watch-tutorial-btn:hover {
          background: #f6f6f7;
          border-color: #8a9099;
        }

        /* Modal Styles */
        .modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background-color: rgba(0, 0, 0, 0.6);
          display: flex;
          justify-content: center;
          align-items: center;
          z-index: 9999;
          padding: 20px;
        }

        .modal-content {
          background: #f5f5f5;
          border-radius: 12px;
          width: 95%;
          max-width: 1400px;
          height: 90vh;
          display: flex;
          position: relative;
          overflow: hidden;
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
        }

        .modal-close-btn {
          position: absolute;
          top: 16px;
          right: 16px;
          background: white;
          border: none;
          width: 32px;
          height: 32px;
          border-radius: 6px;
          font-size: 20px;
          cursor: pointer;
          z-index: 100;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }

        .modal-close-btn:hover {
          background: #f0f0f0;
        }

        /* Left Sidebar */
        .modal-sidebar {
          width: 300px;
          background: white;
          border-right: 1px solid #e0e0e0;
          padding: 24px;
          overflow-y: auto;
        }

        .sidebar-header h3 {
          margin: 0 0 24px 0;
          font-size: 18px;
          font-weight: 600;
          color: #1a1a1a;
        }

        .sidebar-section {
          margin-bottom: 24px;
        }

        .sidebar-label {
          display: block;
          font-size: 13px;
          font-weight: 500;
          color: #4a4a4a;
          margin-bottom: 8px;
        }

        .sidebar-select,
        .sidebar-input {
          width: 100%;
          padding: 10px 12px;
          border: 1px solid #d0d0d0;
          border-radius: 6px;
          font-size: 14px;
          background: white;
        }

        .sidebar-select:focus,
        .sidebar-input:focus {
          outline: none;
          border-color: #5c6ac4;
          box-shadow: 0 0 0 3px rgba(92, 106, 196, 0.1);
        }

        /* Main Content */
        .modal-main {
          flex: 1;
          display: flex;
          flex-direction: column;
          background: white;
          margin: 8px;
          border-radius: 8px;
          overflow: hidden;
        }

        .modal-main-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 20px 24px;
          border-bottom: 1px solid #e0e0e0;
          background: white;
        }

        .header-left {
          display: flex;
          align-items: center;
          gap: 16px;
        }

        .header-left h2 {
          margin: 0;
          font-size: 20px;
          font-weight: 600;
          color: #1a1a1a;
        }

        .modal-status-badge {
          background: #e8f5e9;
          color: #2e7d32;
          padding: 4px 12px;
          border-radius: 12px;
          font-size: 13px;
          font-weight: 500;
        }

        .header-right {
          display: flex;
          gap: 12px;
          align-items: center;
        }

        .icon-btn {
          background: white;
          border: 1px solid #d0d0d0;
          width: 36px;
          height: 36px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 16px;
        }

        .icon-btn:hover {
          background: #f5f5f5;
        }

        .discard-btn {
          background: white;
          border: 1px solid #d0d0d0;
          padding: 8px 16px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 500;
          color: #4a4a4a;
        }

        .discard-btn:hover {
          background: #f5f5f5;
        }

        .save-btn {
          background: #202223;
          color: white;
          border: none;
          padding: 8px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 500;
        }

        .save-btn:hover {
          background: #000000;
        }

        /* Video Wrapper */
        .video-wrapper {
          flex: 1;
          background: #000;
          position: relative;
        }

        .video-wrapper iframe {
          width: 100%;
          height: 100%;
        }

        /* Footer */
        .modal-footer {
          display: flex;
          justify-content: flex-end;
          gap: 12px;
          padding: 16px 24px;
          border-top: 1px solid #e0e0e0;
          background: white;
        }

        .learn-more-btn {
          background: white;
          border: 1px solid #d0d0d0;
          padding: 10px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 500;
          color: #4a4a4a;
        }

        .learn-more-btn:hover {
          background: #f5f5f5;
        }

        .done-btn {
          background: #202223;
          color: white;
          border: none;
          padding: 10px 24px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 500;
        }

        .done-btn:hover {
          background: #000000;
        }

        /* Chat Widget */
        .chat-widget {
          position: fixed;
          bottom: 24px;
          right: 24px;
          z-index: 1000;
        }

        .chat-popup {
          position: absolute;
          bottom: 70px;
          right: 0;
          background: white;
          border-radius: 12px;
          box-shadow: 0 4px 24px rgba(0, 0, 0, 0.15);
          padding: 16px;
          width: 320px;
          border: 1px solid #e4e5e7;
        }

        .chat-popup-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
        }

        .chat-popup-title {
          font-size: 15px;
          font-weight: 600;
          color: #303030;
        }

        .close-btn {
          background: transparent;
          border: none;
          color: #6d7175;
          font-size: 20px;
          cursor: pointer;
          padding: 0;
          line-height: 1;
        }

        .chat-popup-status {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-bottom: 16px;
        }

        .online-indicator {
          width: 8px;
          height: 8px;
          background: #00a863;
          border-radius: 50%;
        }

        .status-text {
          color: #303030;
          font-size: 14px;
          font-weight: 500;
        }

        .chat-icons {
          display: flex;
          gap: 8px;
          margin-left: auto;
        }

        .chat-icon {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 18px;
          border: 2px solid #e4e5e7;
        }

        .qikify-btn {
          background: #303030;
          color: white;
          border: none;
          padding: 12px 20px;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          width: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
        }

        .chat-bubble-btn {
          width: 56px;
          height: 56px;
          background: #303030;
          border-radius: 50%;
          border: none;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 24px;
          color: white;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
          transition: transform 0.2s;
        }

        .chat-bubble-btn:hover {
          transform: scale(1.05);
        }

        @media (max-width: 1024px) {
          .modal-sidebar {
            display: none;
          }
        }

        @media (max-width: 768px) {
          .overview-grid {
            grid-template-columns: 1fr;
          }

          .tutorials-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }

          .onboarding-card {
            flex-direction: column;
          }

          .onboarding-right {
            width: 100%;
          }

          .modal-content {
            width: 100%;
            height: 100vh;
            border-radius: 0;
          }

          .header-left h2 {
            font-size: 16px;
          }

          .icon-btn {
            display: none;
          }
        }

        @media (max-width: 560px) {
          .tutorials-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>

      <div className="setup-container">
        {/* Header */}
        <div className="setup-header" style={{marginBottom: '24px', display: 'flex'}}>
          <h1>Welcome to SmartB2B portal,</h1>
        </div>

       

        {showSetupEssentials ? (
          <div className="setup-essentials-card">
            <div className="setup-essentials-header">
              <div className="setup-essentials-title">
                <span
                  className={`setup-essentials-icon${areAllSetupItemsComplete ? " completed" : ""}`}
                >
                  {areAllSetupItemsComplete ? "✓" : ""}
                </span>
                <span>Setup essentials</span>
              </div>
              <button
                className="setup-essentials-close"
                onClick={() => setShowSetupEssentials(false)}
                aria-label="Close setup essentials"
              >
                ×
              </button>
            </div>

            {setupEssentials.map((item) => {
              const isComplete = isSetupItemComplete(item.label);

              return (
                <div key={item.label} className="setup-essential-row">
                  <div className="setup-essential-label">
                    <span className={`setup-essential-check${isComplete ? " completed" : ""}`}>
                      {isComplete ? "✓" : ""}
                    </span>
                    <span>{item.label}</span>
                  </div>
                  {item.external ? (
                    <a
                      className="setup-essential-link"
                      href={item.href}
                      target="_top"
                      rel="noreferrer"
                      onClick={() => markSetupItemComplete(item.label)}
                    >
                      {item.actionLabel}
                    </a>
                  ) : (
                    <Link
                      className="setup-essential-link"
                      to={item.href}
                      onClick={() => markSetupItemComplete(item.label)}
                    >
                      {item.actionLabel}
                    </Link>
                  )}
                </div>
              );
            })}

            <div className="setup-essentials-footer">
              <button
                className="setup-essentials-button"
                onClick={handleFinishAndClose}
                disabled={!areAllSetupItemsComplete || setupFinished}
              >
                {setupFinished ? "Finished" : "Finish and close"}
              </button>
            </div>
          </div>
        ) : null}

         <div className="overview-card">
          <div className="overview-header">
            <div className="overview-title">Welcome, Dynamic!</div>
            <div className="overview-news">
              <span style={{ fontSize: "16px", lineHeight: 1 }}>🔔</span>
              <span>App news and updates</span>
              <span className="overview-news-dot"></span>
            </div>
          </div>

          <div className="overview-grid">
            <div className="overview-item">
              <div>
                <div className="overview-item-header">
                  <span className="overview-icon" style={{ fontSize: "24px" }}>⌂</span>
                  <span>Pending applications</span>
                </div>
                <div className="overview-count">0</div>
              </div>
              <a
                className="overview-button disabled"
                href="/app/companies?tab=pending"
              >
                Review applications
              </a>
            </div>

            <div className="overview-item">
              <div>
                <div className="overview-item-header">
                  <span className="overview-icon" style={{ fontSize: "20px" }}>⇩</span>
                  <span>Company import</span>
                </div>
                <p className="overview-description">
                  Use the app to bulk create or update companies, locations, and
                  contacts.
                </p>
              </div>
              <syncFetcher.Form method="post">
                <input type="hidden" name="intent" value="syncCompanies" />
                <button
                  type="submit"
                  className="overview-button"
                  disabled={syncFetcher.state !== "idle"}
                >
                  {syncFetcher.state !== "idle" ? "Syncing..." : "View import tool"}
                </button>
              </syncFetcher.Form>
            </div>
          </div>
        </div>

        {/* Tutorials */}
        <div className="tutorials-section">
          <div className="tutorials-header">
            <div>
              <h2 className="tutorials-title">Guide videos</h2>
              <p className="tutorials-subtitle">
                Step-by-step instruction videos, just a few minutes to know the app!
              </p>
            </div>
            <button className="tutorials-menu" type="button" aria-label="Tutorial options">
              ...
            </button>
          </div>
          <div className="tutorials-grid">
            {tutorials.map((tutorial) => (
              <div 
                key={tutorial.id} 
                className="tutorial-card"
                onClick={() => openModal(tutorial)}
              >
                <div className="tutorial-card-visual">
                  <span className="tutorial-card-badge">B2B Portal Guide</span>
                  <div className="tutorial-thumbnail-title">{tutorial.thumbnailTitle}</div>
                  <div className="tutorial-duration">
                    <span className="tutorial-duration-icon">▶</span>
                    <span>{tutorial.duration}</span>
                  </div>
                </div>
                <div className="tutorial-card-body">
                  <span className={`tutorial-tag ${tutorial.tagClass}`}>
                    {tutorial.tag}
                  </span>
                  <h3 className="tutorial-card-title">{tutorial.title}</h3>
                  <p className="tutorial-card-description">{tutorial.description}</p>
                  <button className="watch-tutorial-btn" type="button">
                    Watch video
                  </button>
                </div>
              </div>
            ))}
          </div>
          {/* Need Help Section */}
<div style={{ marginTop: "16px", borderTop: "1px solid #eceef1", paddingTop: "16px" }}>
  <h3 style={{ fontSize: "15px", fontWeight: 700, color: "#303030", marginBottom: "12px" }}>
    Need help with your B2B setup?
  </h3>
  <div style={{
    background: "#f0f4ff",
    borderRadius: "12px",
    padding: "18px 20px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "16px",
  }}>
    <div>
      <p style={{ fontSize: "14px", fontWeight: 700, color: "#1a2366", marginBottom: "6px" }}>
        First time setting up and finding it a bit challenging?
      </p>
      <p style={{ fontSize: "13px", color: "#4a5580", marginBottom: "14px", lineHeight: 1.5 }}>
        Don't worry! We're here to walk you through the app, show you a live demo, and clear up any doubts you have.
      </p>
      <button style={{
        background: "white", border: "1px solid #c9cccf", borderRadius: "8px",
        padding: "8px 16px", fontSize: "13px", fontWeight: 500, color: "#303030", cursor: "pointer"
      }}>
        Book a 30-min session
      </button>
    </div>
    <img src="https://cdn.shopify.com/s/files/1/0938/7068/6498/files/Mascot_BSS_2-04_1.png?v=1766374740" alt="mascot" style={{ width: "80px", flexShrink: 0 }} />
  </div>
 
</div>
        </div>


        {/* Modal Popup */}
        {selectedTutorial && (
          <div className="modal-overlay" onClick={closeModal}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
              {/* Close button */}
              <button className="modal-close-btn" onClick={closeModal}>
                ✕
              </button>

              {/* Main Content Area */}
              <div className="modal-main">
                {/* Header with status */}
                <div className="modal-main-header">
                  <div className="header-left">
                    <h2>{selectedTutorial.title}</h2>  
                  </div>
                </div>

                {/* Video Player */}
                <div className="video-wrapper">
                  <iframe
                    width="100%"
                    height="100%"
                    src={`${selectedTutorial.videoUrl}?autoplay=1`}
                    title={selectedTutorial.title}
                    frameBorder="0"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                  ></iframe>
                </div>

                {/* Footer buttons */}
                <div className="modal-footer">
                </div>
              </div>
            </div>
          </div>
        )}

     
      </div>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
