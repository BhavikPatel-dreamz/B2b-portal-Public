import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams, type HeadersFunction } from "react-router";

type TemplateItem = {
  id: string;
  title: string;
  description: string;
  editorTitle: string;
  helperText: string;
  initialHtml: string;
};

const ToolbarButton = ({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: ReactNode;
}) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    style={{
      width: 34,
      height: 34,
      background: "#ffffff",
      border: "1px solid #c9cccf",
      borderRadius: 8,
      cursor: "pointer",
      fontSize: 14,
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      color: "#303030",
      flexShrink: 0,
    }}
  >
    {children}
  </button>
);

const TEMPLATE_ITEMS: TemplateItem[] = [
  {
    id: "customer-application-received",
    title: "Application received",
    description:
      "This email is sent to a customer when they submit the company application form.",
    editorTitle: "Application received email template",
    helperText:
      "This email is sent to a customer when they submit the company application form.",
    initialHtml:
      "Hello {{contactName}},<br /><br />We have received your B2B registration request for {{companyName}} on {{shopName}}.",
  },
  {
    id: "customer-application-approved",
    title: "Application approved",
    description:
      "This email is sent to a customer when their company account is approved, and can begin placing orders.",
    editorTitle: "Application approved email template",
    helperText:
      "This email is sent to a customer when their company account is approved, and can begin placing orders.",
    initialHtml:
      "Hello {{contactName}},<br /><br />Your company account for {{companyName}} has been approved. You can now begin placing orders on {{shopName}}.",
  },
  {
    id: "customer-revision-requested",
    title: "Revision requested",
    description:
      "This email is sent to a customer when their company application is rejected and a revision has been requested.",
    editorTitle: "Revision requested email template",
    helperText:
      "This email is sent to a customer when their company application is rejected and a revision has been requested.",
    initialHtml:
      "Hello {{contactName}},<br /><br />Your B2B application for {{companyName}} needs a few updates before approval. Please review and resubmit.",
  },
  {
    id: "customer-application-closed",
    title: "Application closed",
    description:
      "Sent to a customer when their company account is rejected, and they are not able to revise their application.",
    editorTitle: "Application closed email template",
    helperText:
      "Sent to a customer when their company account is rejected, and they are not able to revise their application.",
    initialHtml:
      "Hello {{contactName}},<br /><br />Your application for {{companyName}} has been closed. Please contact {{storeOwnerName}} for more information.",
  },
  {
    id: "customer-contact-invited",
    title: "Company contact invited",
    description:
      "Sent to customers when they have been invited as a contact to a company location.",
    editorTitle: "Company contact invited email template",
    helperText:
      "Sent to customers when they have been invited as a contact to a company location.",
    initialHtml:
      "Hello {{contactName}},<br /><br />You have been invited as a contact for {{companyName}} on {{shopName}}.",
  },
];

const ADMIN_TEMPLATE_ITEMS: TemplateItem[] = [
  {
    id: "admin-application-received",
    title: "Application received",
    description:
      "Sent when a customer submits an application for a Company account.",
    editorTitle: "New Company Registration Email Template",
    helperText:
      "This email is sent to the store owner when a new company submits a B2B registration request.",
    initialHtml:
      "Hello {{storeOwnerName}},<br /><br />A new company has submitted a B2B registration request on {{shopName}}.",
  },
  {
    id: "admin-application-revised",
    title: "Application revised",
    description: "Sent when a customer revises an application for a Company account",
    editorTitle: "Application revised email template",
    helperText:
      "This email is sent to the store owner when a customer revises their B2B registration request.",
    initialHtml:
      "Hello {{storeOwnerName}},<br /><br />A company has revised their B2B registration request on {{shopName}}.",
  },
  {
    id: "admin-import-completed",
    title: "Import completed",
    description:
      "Sent when a customer completes an import of their company applications",
    editorTitle: "Import completed email template",
    helperText:
      "This email is sent to the store owner when an import of company applications has completed.",
    initialHtml:
      "Hello {{storeOwnerName}},<br /><br />The company application import has completed on {{shopName}}.",
  },
];

const TEMPLATE_VARIABLES = [
  { variable: "{{companyName}}", description: "Applying company's name" },
  { variable: "{{contactName}}", description: "Contact person's name" },
  { variable: "{{email}}", description: "Contact email address" },
  { variable: "{{storeOwnerName}}", description: "Store owner's name" },
  { variable: "{{shopName}}", description: "Shopify store's name" },
];

export default function NotificationForm() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [showDropdown, setShowDropdown] = useState(false);
  const [editorHasContent, setEditorHasContent] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const selectedTemplateId = searchParams.get("template");

  const allTemplates = useMemo(
    () => [...TEMPLATE_ITEMS, ...ADMIN_TEMPLATE_ITEMS],
    [],
  );

  const selectedTemplate =
    allTemplates.find((template) => template.id === selectedTemplateId) ?? null;

  useEffect(() => {
    if (!selectedTemplate || !editorRef.current) {
      return;
    }

    editorRef.current.innerHTML = selectedTemplate.initialHtml;
    setEditorHasContent(editorRef.current.innerText.trim().length > 0);
  }, [selectedTemplate]);

  const format = (command: string) => {
    document.execCommand(command, false);
    editorRef.current?.focus();
  };

  const handleEditorInput = () => {
    if (!editorRef.current) {
      return;
    }

    setEditorHasContent(editorRef.current.innerText.trim().length > 0);
  };

  const insertVariable = (variable: string) => {
    if (!editorRef.current) {
      return;
    }

    const selection = window.getSelection();

    if (!selection || !selection.rangeCount) {
      editorRef.current.focus();
      return;
    }

    const range = selection.getRangeAt(0);
    range.deleteContents();

    const textNode = document.createTextNode(variable);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.setEndAfter(textNode);
    selection.removeAllRanges();
    selection.addRange(range);

    handleEditorInput();
    editorRef.current.focus();
    setShowDropdown(false);
  };

  if (selectedTemplate) {
    return (
      <s-page>
        <div
          style={{
            background: "#f6f6f7",
            minHeight: "100vh",
            padding: "8px 28px 40px",
          }}
        >
          <div style={{ maxWidth: 1080, margin: "0 auto" }}>
            <button
              type="button"
              onClick={() => setSearchParams({})}
              style={{
                border: "none",
                background: "transparent",
                color: "#0a61c7",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
                padding: 0,
                marginBottom: 18,
              }}
            >
              Back to notifications
            </button>

            <div
              style={{
                background: "#ffffff",
                border: "1px solid #d8dadd",
                borderRadius: 16,
                boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)",
                padding: 18,
              }}
            >
              <h2
                style={{
                  margin: "0 0 14px",
                  fontSize: 16,
                  lineHeight: 1.2,
                  fontWeight: 700,
                  color: "#303030",
                }}
              >
                {selectedTemplate.editorTitle}
              </h2>

              <div
                style={{
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                  padding: 8,
                  background: "#f6f6f7",
                  border: "1px solid #c9cccf",
                  borderRadius: "10px 10px 0 0",
                }}
              >
                <ToolbarButton onClick={() => format("bold")} title="Bold">
                  <strong>B</strong>
                </ToolbarButton>
                <ToolbarButton onClick={() => format("italic")} title="Italic">
                  <em>I</em>
                </ToolbarButton>
                <ToolbarButton onClick={() => format("underline")} title="Underline">
                  <u>U</u>
                </ToolbarButton>
                <div style={{ width: 1, background: "#c9cccf", margin: "0 2px" }} />
                <ToolbarButton
                  onClick={() => format("insertUnorderedList")}
                  title="Bullet list"
                >
                  ≡
                </ToolbarButton>
                <ToolbarButton
                  onClick={() => format("insertOrderedList")}
                  title="Numbered list"
                >
                  ≣
                </ToolbarButton>
                <div style={{ width: 1, background: "#c9cccf", margin: "0 2px" }} />
                <ToolbarButton onClick={() => format("justifyLeft")} title="Align left">
                  ⫷
                </ToolbarButton>
                <ToolbarButton onClick={() => format("justifyCenter")} title="Align center">
                  ≡
                </ToolbarButton>
                <ToolbarButton onClick={() => format("justifyRight")} title="Align right">
                  ⫸
                </ToolbarButton>
                <div style={{ width: 1, background: "#c9cccf", margin: "0 2px" }} />
                <ToolbarButton onClick={() => format("removeFormat")} title="Clear format">
                  ✕
                </ToolbarButton>
              </div>

              <div style={{ position: "relative" }}>
                {!editorHasContent && (
                  <div
                    style={{
                      position: "absolute",
                      top: 14,
                      left: 12,
                      right: 12,
                      color: "#8c9196",
                      fontSize: 14,
                      pointerEvents: "none",
                      lineHeight: 1.65,
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {selectedTemplate.initialHtml.replace(/<br \/>/g, "\n").replace(/<[^>]*>/g, "")}
                  </div>
                )}

                <div
                  ref={editorRef}
                  contentEditable
                  onInput={handleEditorInput}
                  style={{
                    padding: "12px 12px",
                    border: "1px solid #c9cccf",
                    borderTop: "none",
                    borderRadius: "0 0 10px 10px",
                    fontSize: 14,
                    outline: "none",
                    minHeight: 140,
                    background: "#fff",
                    lineHeight: 1.65,
                    color: "#303030",
                  }}
                />
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 12,
                  marginTop: 12,
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    color: "#6d7175",
                    flex: 1,
                    minWidth: 240,
                  }}
                >
                  {selectedTemplate.helperText}
                </div>

                <div style={{ position: "relative" }}>
                  <button
                    type="button"
                    onClick={() => setShowDropdown((prev) => !prev)}
                    style={{
                      padding: "8px 12px",
                      background: "#ffffff",
                      color: "#202223",
                      border: "1px solid #c9cccf",
                      borderRadius: 8,
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    Available variables
                    <span style={{ fontSize: 11 }}>⌄</span>
                  </button>

                  {showDropdown && (
                    <div
                      style={{
                        position: "absolute",
                        right: 0,
                        top: "calc(100% + 6px)",
                        width: 320,
                        background: "#ffffff",
                        border: "1px solid #c9cccf",
                        borderRadius: 10,
                        boxShadow: "0 10px 24px rgba(15, 23, 42, 0.12)",
                        padding: 8,
                        zIndex: 20,
                      }}
                    >
                      <div style={{ display: "grid", gap: 4 }}>
                        {TEMPLATE_VARIABLES.map(({ variable, description }) => (
                          <button
                            key={variable}
                            type="button"
                            onClick={() => insertVariable(variable)}
                            style={{
                              padding: "8px 10px",
                              border: "none",
                              background: "#ffffff",
                              borderRadius: 8,
                              textAlign: "left",
                              cursor: "pointer",
                            }}
                          >
                            <div
                              style={{
                                fontSize: 13,
                                fontWeight: 600,
                                color: "#303030",
                                marginBottom: 2,
                              }}
                            >
                              {variable}
                            </div>
                            <div
                              style={{
                                fontSize: 12,
                                color: "#6d7175",
                              }}
                            >
                              {description}
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </s-page>
    );
  }

  return (
    <s-page>
      <div
        style={{
          background: "#f6f6f7",
          minHeight: "100vh",
          padding: "8px 28px 40px",
        }}
      >
        <div style={{ maxWidth: 1080, margin: "0 auto" }}>
          <h1
            style={{
              margin: "0 0 24px",
              fontSize: 22,
              lineHeight: 1.2,
              fontWeight: 700,
              color: "#303030",
            }}
          >
            Email notifications
          </h1>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "290px minmax(0, 1fr)",
              gap: 36,
              alignItems: "start",
            }}
          >
            <div style={{ paddingTop: 18 }}>
              <h2
                style={{
                  margin: "0 0 8px",
                  fontSize: 16,
                  lineHeight: 1.2,
                  fontWeight: 700,
                  color: "#303030",
                }}
              >
                Customer notifications
              </h2>
              <p
                style={{
                  margin: 0,
                  color: "#6d7175",
                  fontSize: 14,
                  lineHeight: 1.5,
                  fontWeight: 600,
                }}
              >
                Manage email notification content and activity for customer
                account email notifications.
              </p>
            </div>

            <div style={{ display: "grid", gap: 18 }}>
              <section
                style={{
                  background: "#ffffff",
                  border: "1px solid #d8dadd",
                  borderRadius: 16,
                  boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)",
                  padding: 14,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 16,
                    marginBottom: 14,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <h3
                      style={{
                        margin: 0,
                        fontSize: 15,
                        fontWeight: 600,
                        color: "#303030",
                      }}
                    >
                      Customer email notifications
                    </h3>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        minWidth: 30,
                        height: 20,
                        padding: "0 10px",
                        borderRadius: 999,
                        background: "#a8f0b1",
                        color: "#166534",
                        fontSize: 11,
                        fontWeight: 600,
                      }}
                    >
                      On
                    </span>
                  </div>

                  <button
                    type="button"
                    style={{
                      border: "1px solid #c9cccf",
                      background: "#ffffff",
                      color: "#303030",
                      borderRadius: 10,
                      padding: "8px 14px",
                      fontSize: 14,
                      fontWeight: 500,
                      cursor: "pointer",
                    }}
                  >
                    Turn off
                  </button>
                </div>

                <p
                  style={{
                    margin: "0 0 10px",
                    fontSize: 14,
                    color: "#303030",
                    lineHeight: 1.45,
                  }}
                >
                  Customers can receive notifications when:
                </p>
                <ul
                  style={{
                    margin: 0,
                    paddingLeft: 20,
                    color: "#303030",
                    fontSize: 14,
                    lineHeight: 1.65,
                    fontWeight: 600,
                  }}
                >
                  <li>Their application is pending review</li>
                  <li>Their application is approved</li>
                  <li>
                    Their application is rejected, and a revision has been
                    requested
                  </li>
                  <li>Their application is closed</li>
                  <li>
                    They are invited as a contact to a company location
                  </li>
                </ul>
              </section>

              <section
                style={{
                  background: "#ffffff",
                  border: "1px solid #d8dadd",
                  borderRadius: 16,
                  boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)",
                  padding: 14,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: 16,
                    marginBottom: 14,
                  }}
                >
                  <div>
                    <h3
                      style={{
                        margin: "0 0 8px",
                        fontSize: 15,
                        fontWeight: 600,
                        color: "#303030",
                      }}
                    >
                      Sender email
                    </h3>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        flexWrap: "wrap",
                      }}
                    >
                      <span
                        style={{
                          fontSize: 14,
                          color: "#303030",
                          fontWeight: 500,
                        }}
                      >
                        noreply@onboardb2b.com
                      </span>
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          height: 24,
                          padding: "0 10px",
                          borderRadius: 999,
                          background: "#f1f2f4",
                          color: "#6d7175",
                          fontSize: 12,
                          fontWeight: 500,
                        }}
                      >
                        App default
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    style={{
                      border: "1px solid #303030",
                      background: "#2f2f2f",
                      color: "#ffffff",
                      borderRadius: 10,
                      padding: "8px 14px",
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Connect custom email domain
                  </button>
                </div>

                <p
                  style={{
                    margin: 0,
                    color: "#303030",
                    fontSize: 14,
                    lineHeight: 1.5,
                    fontWeight: 600,
                  }}
                >
                  The app is using its default sender email to send email
                  notifications to your customers.
                </p>
              </section>

              <section
                style={{
                  background: "#ffffff",
                  border: "1px solid #d8dadd",
                  borderRadius: 16,
                  boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)",
                  padding: 14,
                }}
              >
                <h3
                  style={{
                    margin: "0 0 14px",
                    fontSize: 15,
                    fontWeight: 600,
                    color: "#303030",
                  }}
                >
                  Customer email templates
                </h3>

                <div
                  style={{
                    border: "1px solid #eceef1",
                    borderRadius: 12,
                    overflow: "hidden",
                    background: "#ffffff",
                  }}
                >
                  {TEMPLATE_ITEMS.map((item, index) => (
                    <button
                      key={item.title}
                      type="button"
                      onClick={() => setSearchParams({ template: item.id })}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        justifyContent: "space-between",
                        gap: 16,
                        width: "100%",
                        padding: "14px 14px 12px",
                        background: "#ffffff",
                        border: "none",
                        borderTop:
                          index === 0 ? "none" : "1px solid #eceef1",
                        textAlign: "left",
                        cursor: "pointer",
                      }}
                    >
                      <div>
                        <div
                          style={{
                            marginBottom: 4,
                            fontSize: 14,
                            fontWeight: 600,
                            color: "#303030",
                          }}
                        >
                          {item.title}
                        </div>
                        <p
                          style={{
                            margin: 0,
                            fontSize: 14,
                            lineHeight: 1.45,
                            color: "#6d7175",
                            fontWeight: 500,
                          }}
                        >
                          {item.description}
                        </p>
                      </div>
                      <span
                        aria-hidden="true"
                        style={{
                          color: "#4a4f55",
                          fontSize: 28,
                          lineHeight: 1,
                          paddingTop: 0,
                        }}
                      >
                        ›
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "290px minmax(0, 1fr)",
              gap: 36,
              alignItems: "start",
              marginTop: 28,
            }}
          >
            <div style={{ paddingTop: 10 }}>
              <h2
                style={{
                  margin: "0 0 8px",
                  fontSize: 16,
                  lineHeight: 1.2,
                  fontWeight: 700,
                  color: "#303030",
                }}
              >
                Admin notifications
              </h2>
              <p
                style={{
                  margin: 0,
                  color: "#6d7175",
                  fontSize: 14,
                  lineHeight: 1.5,
                  fontWeight: 600,
                }}
              >
                Manage recipients and templates for admin email notifications.
              </p>
            </div>

            <div style={{ display: "grid", gap: 14 }}>
              <section
                style={{
                  background: "#ffffff",
                  border: "1px solid #d8dadd",
                  borderRadius: 16,
                  boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)",
                  padding: 14,
                }}
              >
                <h3
                  style={{
                    margin: "0 0 10px",
                    fontSize: 15,
                    fontWeight: 600,
                    color: "#303030",
                  }}
                >
                  Admin email notifications
                </h3>
                <p
                  style={{
                    margin: "0 0 14px",
                    color: "#303030",
                    fontSize: 14,
                    lineHeight: 1.45,
                    fontWeight: 500,
                  }}
                >
                  Receive email notifications from the app when there are new or
                  revised applications to review.
                </p>

                <button
                  type="button"
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    border: "1px solid #d8dadd",
                    borderRadius: 10,
                    background: "#ffffff",
                    color: "#303030",
                    padding: "10px 12px",
                    fontSize: 14,
                    fontWeight: 500,
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: "50%",
                      border: "1px solid #6d7175",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "#6d7175",
                      fontSize: 12,
                      lineHeight: 1,
                      flexShrink: 0,
                    }}
                  >
                    +
                  </span>
                  <span>Add recipient</span>
                </button>
              </section>

              <section
                style={{
                  background: "#ffffff",
                  border: "1px solid #d8dadd",
                  borderRadius: 16,
                  boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)",
                  padding: 14,
                }}
              >
                <h3
                  style={{
                    margin: "0 0 10px",
                    fontSize: 15,
                    fontWeight: 600,
                    color: "#303030",
                  }}
                >
                  Admin email templates
                </h3>
                <p
                  style={{
                    margin: "0 0 14px",
                    color: "#303030",
                    fontSize: 14,
                    lineHeight: 1.45,
                    fontWeight: 500,
                  }}
                >
                  App emails are sent by noreply@onboardb2b.com
                </p>

                <div
                  style={{
                    border: "1px solid #eceef1",
                    borderRadius: 12,
                    overflow: "hidden",
                    background: "#ffffff",
                  }}
                >
                  {ADMIN_TEMPLATE_ITEMS.map((item, index) => (
                    <button
                      key={item.title}
                      type="button"
                      onClick={() => setSearchParams({ template: item.id })}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        justifyContent: "space-between",
                        gap: 16,
                        width: "100%",
                        padding: "14px 14px 12px",
                        background: "#ffffff",
                        border: "none",
                        borderTop:
                          index === 0 ? "none" : "1px solid #eceef1",
                        textAlign: "left",
                        cursor: "pointer",
                      }}
                    >
                      <div>
                        <div
                          style={{
                            marginBottom: 4,
                            fontSize: 14,
                            fontWeight: 600,
                            color: "#303030",
                          }}
                        >
                          {item.title}
                        </div>
                        <p
                          style={{
                            margin: 0,
                            fontSize: 14,
                            lineHeight: 1.45,
                            color: "#6d7175",
                            fontWeight: 500,
                          }}
                        >
                          {item.description}
                        </p>
                      </div>
                      <span
                        aria-hidden="true"
                        style={{
                          color: "#4a4f55",
                          fontSize: 28,
                          lineHeight: 1,
                          paddingTop: 0,
                        }}
                      >
                        ›
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = () => {
  return {};
};
