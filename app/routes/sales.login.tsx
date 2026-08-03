import { LoaderFunctionArgs, ActionFunctionArgs, redirect } from "react-router";
import { useState } from "react";
import {
  Form,
  useLoaderData,
  useActionData,
  useNavigation,
  Link,
} from "react-router";
import prisma from "app/db.server";
import {
  getSessionTokenFromCookie,
  validateSalesSession,
  createSalesSession,
  buildSessionCookie,
} from "app/utils/sales-session.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // If already logged in, redirect to portal
  const existingToken = getSessionTokenFromCookie(request);
  if (existingToken) {
    const result = await validateSalesSession(existingToken);
    if (result.valid) {
      return redirect("/sales/portal");
    }
  }

  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  const success = url.searchParams.get("success");

  return Response.json({ error, success });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const email = (formData.get("email") as string)?.trim().toLowerCase();
  const password = formData.get("password") as string;

  if (!email || !password) {
    return Response.json({ error: "Email and password are required." });
  }

  // Find user by email with SALES_USER role (across all stores)
  const user = await prisma.user.findFirst({
    where: {
      email,
      role: "SALES_USER",
      status: "APPROVED",
      isActive: true,
    },
    include: {
      salesCompanies: {
        include: {
          company: {
            select: { id: true },
          },
        },
      },
    },
  });

  if (!user) {
    return Response.json({ error: "Invalid email or password." });
  }

  // Verify password securely using bcrypt
  const bcrypt = await import("bcryptjs");
  const isValidPassword = await bcrypt.compare(password, user.password);

  if (!isValidPassword) {
    return Response.json({ error: "Invalid email or password." });
  }

  // Create session and set cookie
  const sessionToken = await createSalesSession(user.id);

  return redirect("/sales/portal", {
    headers: {
      "Set-Cookie": buildSessionCookie(sessionToken),
    },
  });
};

export default function SalesLogin() {
  const loaderData = useLoaderData<{
    error: string | null;
    success: string | null;
  }>();
  const actionData = useActionData<{ error?: string }>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const [passwordVisible, setPasswordVisible] = useState(false);

  return (
    <div style={styles.pageContainer}>
      {/* Animated background blobs */}
      <div style={styles.bgBlob1} />
      <div style={styles.bgBlob2} />
      <div style={styles.bgBlob3} />

      <div style={styles.card}>
        {/* Logo / branding */}
        <div style={styles.logoRow}>
          <div style={styles.logoIcon}>
            <img
              src="https://cdn.shopify.com/s/files/applications/c6da0a0589e2c3c978aadf2afec07db7_200x200.png?v=1776950914"
              alt="Logo"
              style={styles.logoImage}
            />
          </div>
          <span style={styles.logoText}>SmartB2B</span>
        </div>

        <div style={styles.header}>
          <h1 style={styles.heroText}>Sales Portal</h1>
          <p style={styles.bodyText}>
            Sign in with your email and password to manage your assigned
            companies.
          </p>
        </div>

        {/* Success message (e.g., after setting password) */}
        {loaderData?.success && (
          <div style={styles.successAlert}>
            {loaderData.success === "password_set"
              ? "Your password has been set successfully! You can now sign in."
              : loaderData.success}
          </div>
        )}

        {/* Error messages */}
        {(actionData?.error || loaderData?.error) && (
          <div style={styles.errorAlert}>
            {actionData?.error ||
              (loaderData?.error === "expired"
                ? "Your session has expired. Please sign in again."
                : loaderData?.error === "unauthorized"
                  ? "Please sign in to continue."
                  : loaderData?.error)}
          </div>
        )}

        <Form method="post" style={styles.form}>
          <div style={styles.inputGroup}>
            <label htmlFor="sales-email" style={styles.label}>
              Email Address
            </label>
            <input
              id="sales-email"
              type="email"
              name="email"
              required
              autoComplete="email"
              style={styles.input}
              placeholder="you@company.com"
            />
          </div>

          <div style={styles.inputGroup}>
            <label htmlFor="sales-password" style={styles.label}>
              Password
            </label>
            <div style={styles.passwordFieldWrapper}>
              <input
                id="sales-password"
                type={passwordVisible ? "text" : "password"}
                name="password"
                required
                minLength={6}
                autoComplete="current-password"
                style={styles.input}
                placeholder="Enter your password"
              />
              <button
                type="button"
                onClick={() => setPasswordVisible((prev) => !prev)}
                style={styles.passwordToggle}
                aria-label={passwordVisible ? "Hide password" : "Show password"}
              >
                {passwordVisible ? (
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20C7.58 20 3.73 17.11 1.99 12.76" />
                    <path d="M9.53 9.53A3 3 0 0 1 14.47 14.47" />
                    <path d="M1 1l22 22" />
                    <path d="M16.68 16.68A9.94 9.94 0 0 0 21 12c-1.58-4.36-5.43-7.25-9.85-7.25a9.94 9.94 0 0 0-4.35.95" />
                  </svg>
                ) : (
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          <button
            id="sales-login-submit"
            type="submit"
            style={{
              ...styles.button,
              opacity: isSubmitting ? 0.7 : 1,
              cursor: isSubmitting ? "not-allowed" : "pointer",
            }}
            disabled={isSubmitting}
          >
            {isSubmitting ? "Signing in..." : "Sign In"}
          </button>
        </Form>

        <div style={styles.footerActions}>
          <Link to="/sales/forgot-password" style={styles.linkText}>
            Forgot password?
          </Link>
          <p style={styles.footerText}>
            Don't have an account? Contact your store admin for an invitation.
          </p>
        </div>
      </div>

      <style>{`
        @keyframes blobFloat1 {
          0%, 100% { transform: translate(0, 0) scale(1); }
          33% { transform: translate(30px, -40px) scale(1.1); }
          66% { transform: translate(-20px, 20px) scale(0.95); }
        }
        @keyframes blobFloat2 {
          0%, 100% { transform: translate(0, 0) scale(1); }
          33% { transform: translate(-40px, 30px) scale(1.05); }
          66% { transform: translate(25px, -25px) scale(0.9); }
        }
        @keyframes blobFloat3 {
          0%, 100% { transform: translate(0, 0) scale(1); }
          50% { transform: translate(20px, 30px) scale(1.08); }
        }
        
        input:focus {
          border-color: #E91E63 !important;
          box-shadow: 0 0 0 3px rgba(233, 30, 99, 0.12) !important;
        }
        
        button[type="submit"]:hover:not(:disabled) {
          transform: translateY(-1px);
          box-shadow: 0 8px 20px rgba(233, 30, 99, 0.4) !important;
        }
        button[type="submit"]:active:not(:disabled) {
          transform: translateY(0);
        }
      `}</style>
    </div>
  );
}

const styles = {
  pageContainer: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background:
      "linear-gradient(135deg, #fdf4f7 0%, #fff7eb 50%, #f3e8ff 100%)",
    fontFamily: "'Inter', system-ui, sans-serif",
    padding: "20px",
    position: "relative" as const,
    overflow: "hidden",
  },
  bgBlob1: {
    position: "absolute" as const,
    top: "-10%",
    left: "-5%",
    width: "400px",
    height: "400px",
    borderRadius: "50%",
    background:
      "radial-gradient(circle, rgba(233,30,99,0.08) 0%, transparent 70%)",
    animation: "blobFloat1 8s ease-in-out infinite",
    pointerEvents: "none" as const,
  },
  bgBlob2: {
    position: "absolute" as const,
    bottom: "-15%",
    right: "-10%",
    width: "500px",
    height: "500px",
    borderRadius: "50%",
    background:
      "radial-gradient(circle, rgba(255,107,53,0.08) 0%, transparent 70%)",
    animation: "blobFloat2 10s ease-in-out infinite",
    pointerEvents: "none" as const,
  },
  bgBlob3: {
    position: "absolute" as const,
    top: "50%",
    left: "50%",
    width: "300px",
    height: "300px",
    borderRadius: "50%",
    background:
      "radial-gradient(circle, rgba(225,190,231,0.1) 0%, transparent 70%)",
    animation: "blobFloat3 12s ease-in-out infinite",
    pointerEvents: "none" as const,
  },
  card: {
    position: "relative" as const,
    zIndex: 1,
    background: "rgba(255, 255, 255, 0.92)",
    backdropFilter: "blur(20px)",
    WebkitBackdropFilter: "blur(20px)",
    borderRadius: "28px",
    padding: "48px",
    width: "100%",
    maxWidth: "440px",
    boxShadow: "0 24px 48px rgba(0,0,0,0.08), 0 1px 4px rgba(0,0,0,0.04)",
    border: "1px solid rgba(255,255,255,0.6)",
  },
  logoRow: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    marginBottom: "28px",
  },
  logoIcon: {
    width: "48px",
    height: "48px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  logoImage: {
    width: "100%",
    height: "100%",
    objectFit: "contain" as const,
  },
  logoText: {
    fontFamily: "'Poppins', sans-serif",
    fontSize: "22px",
    fontWeight: 700,
    background: "linear-gradient(135deg, #E91E63 0%, #FF6B35 100%)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
  },
  header: {
    marginBottom: "32px",
  },
  heroText: {
    fontFamily: "'Poppins', sans-serif",
    fontSize: "32px",
    fontWeight: 700,
    margin: "0 0 12px 0",
    lineHeight: 1.2,
    letterSpacing: "-0.02em",
    color: "#111827",
  },
  bodyText: {
    fontSize: "15px",
    color: "#6b7280",
    lineHeight: 1.6,
    margin: 0,
  },
  form: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "20px",
  },
  inputGroup: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "6px",
  },
  label: {
    fontSize: "13px",
    fontWeight: 600,
    color: "#374151",
    letterSpacing: "0.01em",
  },
  // input: {
  //   padding: "14px 16px",
  //   borderRadius: "12px",
  //   border: "1.5px solid #e5e7eb",
  //   fontSize: "15px",
  //   fontFamily: "'Inter', sans-serif",
  //   transition: "border-color 0.2s, box-shadow 0.2s",
  //   outline: "none",
  //   backgroundColor: "#fafafa",
  // },
  // passwordFieldWrapper: {
  //   display: "flex",
  //   flexDirection: "column" as const,
  //   alignItems: "stretch",
  //   gap: "8px",
  //   width: "100%",
  // },
  // passwordToggle: {
  //   border: "1px solid #e5e7eb",
  //   backgroundColor: "#ffffff",
  //   color: "#6B7280",
  //   cursor: "pointer",
  //   display: "flex",
  //   alignItems: "center",
  //   justifyContent: "center",
  //   width: "40px",
  //   height: "40px",
  //   padding: 0,
  //   borderRadius: "12px",
  //   alignSelf: "flex-end" as const,
  //   marginTop: "0px",
  //   boxShadow: "0 1px 3px rgba(15, 23, 42, 0.08)",
  //   transition: "transform 0.15s ease, box-shadow 0.15s ease",
  // },
  button: {
    marginTop: "4px",
    padding: "15px 24px",
    borderRadius: "14px",
    border: "none",
    background:
      "linear-gradient(135deg, var(--sales-portal-accent) 0%, var(--sales-portal-accent-dark) 100%)",
    color: "var(--sales-portal-accent-contrast)",
    fontSize: "16px",
    fontWeight: 600,
    fontFamily: "'Poppins', sans-serif",
    cursor: "pointer",
    transition: "transform 0.2s, box-shadow 0.2s, opacity 0.2s",
    boxShadow: "0 4px 14px var(--sales-portal-focus-ring)",
    letterSpacing: "0.01em",
  },
  successAlert: {
    background: "linear-gradient(135deg, #dcfce7 0%, #d1fae5 100%)",
    color: "#166534",
    padding: "14px 18px",
    borderRadius: "12px",
    marginBottom: "20px",
    fontSize: "14px",
    fontWeight: 500,
    border: "1px solid #bbf7d0",
  },
  errorAlert: {
    background: "linear-gradient(135deg, #fee2e2 0%, #fecaca 100%)",
    color: "#991b1b",
    padding: "14px 18px",
    borderRadius: "12px",
    marginBottom: "20px",
    fontSize: "14px",
    fontWeight: 500,
    border: "1px solid #fca5a5",
  },
  footerActions: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    gap: "8px",
    marginTop: "24px",
  },
  footerText: {
    textAlign: "center" as const,
    fontSize: "13px",
    color: "#9ca3af",
    margin: 0,
    lineHeight: 1.5,
  },
  linkText: {
    fontSize: "14px",
    fontWeight: 600,
    color: "#E91E63",
    textDecoration: "none",
  },
   passwordFieldWrapper: {
    position: "relative" as const,
    width: "100%",
  },

  input: {
    width: "100%",
    padding: "10px 44px 10px 12px", // right padding for icon space
    fontSize: "14px",
    border: "1px solid #E2E2E2",
    borderRadius: "8px",
    outline: "none",
    boxSizing: "border-box" as const,
    backgroundColor: "#FAFAFA",
  },

  passwordToggle: {
    position: "absolute" as const,
    right: "8px",
    top: "50%",
    transform: "translateY(-50%)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "32px",
    height: "32px",
    padding: 0,
    background: "transparent",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
    color: "#6B7280",
  },
};
