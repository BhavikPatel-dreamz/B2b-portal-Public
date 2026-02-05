import {
  useLoaderData,
  type HeadersFunction
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import  { useState } from "react";
import prisma from "app/db.server";
import { authenticate } from "app/shopify.server";
import { LoaderFunctionArgs } from "react-router";

// type LoaderData = {
//   isAuthenticated: boolean;
//   totalCompanies?: number;
//   pendingRegistrations?: number;
//   approvedRegistrations?: number;
//   rejectedRegistrations?: number;
//   totalUsers?: number;
//   totalOrders?: number;
//   totalCreditAllowed?: number;
//   totalCreditUsed?: number;
//   availableCredit?: number;
//   pendingCreditAmount?: number;
// };

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
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop }, 
  });

  if (!store) {
    return Response.json(
      { submissions: [], storeMissing: true },
      { status: 404 },
    );
  }


  return Response.json({
    store
  });
};

export default function Welcome() {
  const { store } = useLoaderData<typeof loader>() as { 
    store: { shopDomain: string } | null 
  };
  const [isGuideCollapsed, setIsGuideCollapsed] = useState(false);

  
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



  const [selectedTutorial, setSelectedTutorial] = useState<Tutorial | null>(null);
  const tutorials = [
    {
      id: 1,
      tag: "Storefront",
      tagClass: "tag-storefront",
      title: "Enable B2B Registration on Storefront",
      description: "Learn how to enable the app embed and display the B2B company registration form on your storefront so wholesale customers can apply.",
      videoUrl: "https://www.youtube.com/embed/d56mG7DezGs"
    },
    {
      id: 2,
      tag: "Store setup",
      tagClass: "tag-customer",
      title: "Create & Publish B2B Portal Page",
      description: "Step-by-step guide to creating a B2B portal page, adding the app block, and linking it to your store menu.",
      videoUrl: "https://www.youtube.com/embed/d56mG7DezGs"
    },
    {
      id: 3,
      tag: "Admin workflow",
      tagClass: "tag-customer",
      title: "Approve Companies & Manage Access",
      description: "See how to review B2B registrations, approve companies, manage users, locations, and assign roles.",
      videoUrl: "https://www.youtube.com/embed/d56mG7DezGs"
    }
  ];

  const openModal = (tutorial: Tutorial) => {
    setSelectedTutorial(tutorial);
  };

  const closeModal = () => {
    setSelectedTutorial(null);
  };


  return (
    <div style={{ background: "#f1f2f4", minHeight: "100vh", padding: "24px" }}>
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
          border-radius: 8px;
          padding: 20px;
          border: 1px solid #e4e5e7;
        }

        .tutorials-title {
          font-size: 18px;
          font-weight: 600;
          color: #303030;
          margin-bottom: 20px;
        }

        .tutorials-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 16px;
        }

        .tutorial-card {
          border: 1px solid #e4e5e7;
          border-radius: 8px;
          padding: 16px;
          cursor: pointer;
          transition: all 0.2s;
        }

        .tutorial-card:hover {
          transform: translateY(-4px);
          box-shadow: 0 8px 16px rgba(0, 0, 0, 0.1);
          border-color: #c9cccf;
        }

        .tutorial-tag {
          display: inline-block;
          padding: 4px 10px;
          border-radius: 4px;
          font-size: 12px;
          font-weight: 500;
          margin-bottom: 12px;
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
          font-size: 15px;
          font-weight: 600;
          color: #303030;
          margin-bottom: 8px;
        }

        .tutorial-card-description {
          color: #6d7175;
          font-size: 13px;
          line-height: 1.5;
          margin-bottom: 16px;
        }

        .watch-tutorial-btn {
          background: white;
          color: #303030;
          border: 1px solid #c9cccf;
          padding: 8px 16px;
          border-radius: 6px;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
          width: 100%;
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
          .tutorials-grid {
            grid-template-columns: 1fr;
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
      `}</style>

      <div className="setup-container">
        {/* Header */}
        <div className="setup-header" style={{marginBottom: '24px', display: 'flex'}}>
          <h1>Welcome to B2B portal,</h1>
        </div>

        {/* Setup Guide */}
       
        <div className="setup-guide-card">
          <div className="setup-guide-header">
            <div>
              <h2 className="setup-guide-title">Setup guide</h2>
              <p className="setup-guide-description">
                Use this personalized guide to set up a B2B extension on your store.
              </p>
            </div>
            <button
              className={`collapse-btn ${isGuideCollapsed ? "collapsed" : ""}`}
              onClick={() => setIsGuideCollapsed(!isGuideCollapsed)}
            >
              ^
            </button>
          </div>

          {!isGuideCollapsed && (
            <>
              {/* Step 2 */}
              <div className="setup-step">
                <div 
                  className={`step-radio ${completedSteps.step2 ? 'checked' : ''}`}
                  onClick={() => toggleStep('step2')}
                >
                  <div className="radio-circle">
                    {completedSteps.step2 && <div className="radio-dot"></div>}
                  </div>
                </div>
                <div className="step-content">
                  <button
                    className="create-form-btn"
                    onClick={() => window.open(`https://admin.shopify.com/store/${getStoreName()}/themes`, "_top")}
                  >
                    Enable theme app extensions
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Tutorials */}
        <div className="tutorials-section">
          <h2 className="tutorials-title">Tutorials</h2>
          <div className="tutorials-grid">
            {tutorials.map((tutorial) => (
              <div 
                key={tutorial.id} 
                className="tutorial-card"
                onClick={() => openModal(tutorial)}
              >
                <span className={`tutorial-tag ${tutorial.tagClass}`}>
                  {tutorial.tag}
                </span>
                <h3 className="tutorial-card-title">{tutorial.title}</h3>
                <p className="tutorial-card-description">{tutorial.description}</p>
                <button className="watch-tutorial-btn">Watch tutorial</button>
              </div>
            ))}
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

        {/* Chat Widget */}
        {/* <div className="chat-widget">
          {isChatOpen && (
            <div className="chat-popup">
              <div className="chat-popup-header">
                <div className="chat-popup-title">Questions? Chat with us!</div>
                <button
                  className="close-btn"
                  onClick={() => setIsChatOpen(false)}
                >
                  ×
                </button>
              </div>
              <div className="chat-popup-status">
                <div className="online-indicator"></div>
                <div className="status-text">Support is online</div>
                <div className="chat-icons">
                  <div className="chat-icon">😊</div>
                  <div className="chat-icon">👤</div>
                  <div className="chat-icon">💬</div>
                </div>
              </div>
              <button className="qikify-btn">💬 Chat with Qikify Plus</button>
            </div>
          )}
          <button
            className="chat-bubble-btn"
            onClick={() => setIsChatOpen(!isChatOpen)}
          >
            💬
          </button>
        </div> */}
      </div>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
