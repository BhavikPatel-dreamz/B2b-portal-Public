import {
  Link,
  type HeadersFunction,
  type LoaderFunctionArgs,
  useLoaderData,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import React, { useState } from "react";

type LoaderData = {
  isAuthenticated: boolean;
  totalCompanies?: number;
  pendingRegistrations?: number;
  approvedRegistrations?: number;
  rejectedRegistrations?: number;
  totalUsers?: number;
  totalOrders?: number;
  totalCreditAllowed?: number;
  totalCreditUsed?: number;
  availableCredit?: number;
  pendingCreditAmount?: number;
};

export default function Welcome() {
  const data = useLoaderData<LoaderData>();

  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isGuideCollapsed, setIsGuideCollapsed] = useState(false);
    const [isEnabled, setIsEnabled] = useState(false);

  const handleToggle = () => {
    setIsEnabled(!isEnabled);
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
          justify-content: space-between;
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
          transition: all 0.2s;
        }

        .tutorial-card:hover {
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
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
        }
      `}</style>

      <div className="setup-container">
        {/* Header */}
        <div className="setup-header">
          <h1>Welcome to B2B portal,</h1>
          <button className="help-center-btn">Help center</button>
        </div>

        {/* App Embed Status */}
         <div className="embed-status-card">
      <div className="embed-status-left">
        <div className="embed-status-title">
          B2B portal app embed status
          <span className={`status-badge ${isEnabled ? "enabled" : "disabled"}`}>
            {isEnabled ? "Enabled" : "Disabled"}
          </span>
        </div>
        <div className="embed-status-description">
          To display B2B registration form, please enable and save app embed
          block on Shopify Theme Editor.
        </div>
      </div>
      <button className="enable-app-btn" onClick={handleToggle}>
        {isEnabled ? "Disable app" : "Enable app"}
      </button>
    </div>

        {/* Setup Guide */}
        <div className="setup-guide-card">
          <div className="setup-guide-header">
            <div>
              <h2 className="setup-guide-title">Setup guide</h2>
              <p className="setup-guide-description">
                Use this personalized guide to set up a B2B registration form
                and activate B2B quick order extensions on your store.
              </p>
              <p className="progress-text">0 / 3 completed</p>
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
              {/* Step 1 */}
              <div className="setup-step">
                <div className="step-icon">
                  <div className="step-icon-inner"></div>
                </div>
                <div className="step-content">
                  <div className="step-title">
                    Set up B2B Company Registration form
                  </div>
                  <div className="step-description">
                    Publish a B2B company registration form to collect and
                    review all B2B company submissions
                  </div>
                  <button
                    className="create-form-btn"
                    onClick={() => {
                      window.open(
                        "https://admin.shopify.com/store/findash-shipping-1/themes",
                        "_top",
                      );
                    }}
                  >
                    Create form
                  </button>
                </div>
              </div>

              {/* Step 2 */}
              <div className="setup-step">
                <div className="step-icon">
                  <div className="step-icon-inner"></div>
                </div>
                <div className="step-content">
                  <div className="step-title">Enable theme app extensions</div>
                </div>
              </div>

              {/* Step 3 */}
              <div className="setup-step">
                <div className="step-icon">
                  <div className="step-icon-inner"></div>
                </div>
                <div className="step-content">
                  <div className="step-title">
                    Explore all B2B extensions in Customer Account
                    <span className="update-badge">
                      Shopify's latest update
                    </span>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Tutorials */}
        <div className="tutorials-section">
          <h2 className="tutorials-title">Tutorials</h2>
          <div className="tutorials-grid">
            {/* Tutorial 1 */}
            <div className="tutorial-card">
              <span className="tutorial-tag tag-storefront">Storefront</span>
              <h3 className="tutorial-card-title">
                Display B2B/Wholesale registration form
              </h3>
              <p className="tutorial-card-description">
                The detailed steps to display a B2B company registration form on
                your storefront
              </p>
              <button className="watch-tutorial-btn">Watch tutorial</button>
            </div>

            {/* Tutorial 2 */}
            <div className="tutorial-card">
              <span className="tutorial-tag tag-customer">
                Customer account
              </span>
              <h3 className="tutorial-card-title">
                Add Quick order with SKUs page
              </h3>
              <p className="tutorial-card-description">
                Set up a quick order page where customers can input and order
                with a list of SKUs & quantities.
              </p>
              <button className="watch-tutorial-btn">Watch tutorial</button>
            </div>

            {/* Tutorial 3 */}
            <div className="tutorial-card">
              <span className="tutorial-tag tag-customer">
                Customer account
              </span>
              <h3 className="tutorial-card-title">
                Add Quick order with CSV Upload
              </h3>
              <p className="tutorial-card-description">
                Set up a quick order block where customers can order by
                uploading a CSV file.
              </p>
              <button className="watch-tutorial-btn">Watch tutorial</button>
            </div>
          </div>
        </div>

        {/* Chat Widget */}
        <div className="chat-widget">
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
        </div>
      </div>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
