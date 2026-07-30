import { LoaderFunctionArgs, ActionFunctionArgs, redirect } from "react-router";
import { Form, useLoaderData, useActionData, useNavigation } from "react-router";
import { useEffect, useState } from "react";
import prisma from "app/db.server";
import { createSalesSession, buildSessionCookie } from "app/utils/sales-session.server";
import { getStoreByDomain } from "app/services/store.server";

interface LoaderData {
  valid: boolean;
  user?: {
    email: string;
    firstName: string | null;
    lastName: string | null;
  };
  storeid?: string;
  userid?: string;
  token?: string;
  themeColor?: string;
  message?: string;
}

export const loader = async ({ request }: LoaderFunctionArgs): Promise<LoaderData | Response> => {
  const url = new URL(request.url);
  const storeid = url.searchParams.get("storeid");
  const userid = url.searchParams.get("userid");
  const token = url.searchParams.get("token");

  if (!storeid || !userid || !token) {
    return { valid: false, message: "Invalid invitation link.", themeColor: "#E91E63" };
  }

  const invitation = await prisma.invitation.findUnique({
    where: { token, userId: userid, shopId: storeid },
    include: { user: true },
  });

  if (!invitation) {
    return { valid: false, message: "Invitation not found.", themeColor: "#E91E63" };
  }

  // Check if user already set password — redirect to login page
  if (!invitation.isActive && invitation.user.status === "APPROVED") {
    return redirect("/sales/login?success=password_set");
  }

  if (!invitation.isActive) {
    return { valid: false, message: "Invitation is no longer active.", themeColor: "#E91E63" };
  }

  // Check expiration with proper date comparison
  const now = new Date().getTime();
  const expiresAtTime = new Date(invitation.expiresAt).getTime();
  
  if (now > expiresAtTime) {
    return { valid: false, message: "Invitation has expired.", themeColor: "#E91E63" };
  }

  // Fetch store theme color
  const store = await prisma.store.findUnique({
    where: { id: storeid },
    select: { themeColor: true },
  });

  return {
    valid: true,
    user: {
      email: invitation.user.email,
      firstName: invitation.user.firstName,
      lastName: invitation.user.lastName,
    },
    storeid,
    userid,
    token,
    themeColor: store?.themeColor || "#E91E63",
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return { error: "Invalid request method." };
  }

  const formData = await request.formData();
  const password = formData.get("password") as string;
  const storeid = formData.get("storeid") as string;
  const userid = formData.get("userid") as string;
  const token = formData.get("token") as string;

  // Validate required fields
  if (!password || !storeid || !userid || !token) {
    return { error: "Missing required fields." };
  }

  if (password.length < 6) {
    return { error: "Password must be at least 6 characters." };
  }

  try {
    const invitation = await prisma.invitation.findUnique({
      where: { token, userId: userid, shopId: storeid },
    });

    if (!invitation) {
      return { error: "Invalid or expired invitation." };
    }

    if (!invitation.isActive) {
      return { error: "Invalid or expired invitation." };
    }

    // Check expiration with proper date comparison
    const now = new Date().getTime();
    const expiresAtTime = new Date(invitation.expiresAt).getTime();
    
    if (now > expiresAtTime) {
      return { error: "Invalid or expired invitation." };
    }

    // Hash the password securely
    const bcrypt = await import("bcryptjs");
    const hashedPassword = await bcrypt.hash(password, 10);

    // Set the password and approve the user
    await prisma.user.update({
      where: { id: userid },
      data: {
        password: hashedPassword,
        status: "APPROVED",
        isActive: true,
      },
    });

    // Deactivate invitation
    await prisma.invitation.update({
      where: { id: invitation.id },
      data: { isActive: false },
    });

    // Get user's assigned companies
    const userWithCompanies = await prisma.user.findUnique({
      where: { id: userid },
      include: {
        salesCompanies: {
          select: { companyId: true },
        },
      },
    });

    // Create a cookie-based session
    const sessionToken = await createSalesSession(userid);
    
    // Redirect to portal - if no companies, dashboard will show empty state
    const companyId = userWithCompanies?.salesCompanies[0]?.companyId;
    const redirectUrl = companyId 
      ? `/sales/portal?companyId=${companyId}` 
      : `/sales/portal`;

    // Use server-side redirect with Set-Cookie header
    return redirect(redirectUrl, {
      headers: {
        "Set-Cookie": buildSessionCookie(sessionToken),
      },
    });
  } catch (error) {
    console.error("Password setup error:", error);
    return { 
      error: "An error occurred while setting up your account. Please try again." 
    };
  }
};

export default function SupportLogin() {
  const loaderData = useLoaderData<LoaderData>();
  const actionData = useActionData<{ error?: string }>();
  const navigation = useNavigation();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isSubmittingForm = navigation.state === "submitting";

  // Track form submission
  useEffect(() => {
    setIsSubmitting(isSubmittingForm);
  }, [isSubmittingForm]);

  // Reset loading state if there's an error
  useEffect(() => {
    if (actionData?.error) {
      setIsSubmitting(false);
    }
  }, [actionData?.error]);

  if (!loaderData.valid) {
    const themeColor = loaderData.themeColor || "#E91E63";
    const errorStyles = {
      heroText: {
        ...styles.heroText,
        background: `linear-gradient(135deg, ${themeColor} 0%, ${themeColor}99 100%)`,
      } as const,
    };
    
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <h1 style={errorStyles.heroText}>Link Expired</h1>
          <p style={styles.bodyText}>{loaderData.message}</p>
          <div style={{
            marginTop: "24px",
            padding: "16px",
            backgroundColor: "#f0f4f8",
            borderRadius: "12px",
            borderLeft: `4px solid ${themeColor}`,
          }}>
            <p style={{ margin: "0 0 12px 0", fontSize: "14px", fontWeight: 500, color: "#333" }}>
              What to do next:
            </p>
            <ul style={{ margin: 0, paddingLeft: "20px", fontSize: "14px", color: "#555", lineHeight: 1.6 }}>
              <li>Contact your store administrator to request a new invitation link</li>
              <li>Check your email for any new invitation messages</li>
              <li>If you have other questions, reach out to support</li>
            </ul>
          </div>
        </div>
      </div>
    );
  }

  // Get theme color for dynamic styling
  const themeColor = loaderData.themeColor || "#E91E63";
  const dynamicStyles = {
    ...styles,
    heroText: {
      ...styles.heroText,
      background: `linear-gradient(135deg, ${themeColor} 0%, ${themeColor}99 100%)`,
    } as const,
    button: {
      ...styles.button,
      background: `linear-gradient(135deg, ${themeColor} 0%, ${themeColor}dd 100%)`,
      boxShadow: `0 4px 12px ${themeColor}4d`,
    } as const,
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <div style={styles.header}>
          <h1 style={dynamicStyles.heroText}>Welcome, {loaderData.user?.firstName || "User"}!</h1>
          <p style={styles.bodyText}>
            You've been invited as a Sales Support user. Please set your password to activate your account.
          </p>
        </div>

        {actionData?.error && (
          <div style={styles.errorAlert}>
            {actionData.error}
          </div>
        )}

        <Form method="post" style={styles.form}>
          <input type="hidden" name="storeid" value={loaderData.storeid || ""} />
          <input type="hidden" name="userid" value={loaderData.userid || ""} />
          <input type="hidden" name="token" value={loaderData.token || ""} />

          <div style={styles.inputGroup}>
            <label style={styles.label}>Email Address</label>
            <input
              type="email"
              value={loaderData.user?.email || ""}
              disabled
              style={{ ...styles.input, backgroundColor: "#f5f5f5", color: "#888" }}
            />
          </div>

          <div style={styles.inputGroup}>
            <label style={styles.label}>Create Password</label>
            <input
              type="password"
              name="password"
              required
              minLength={6}
              disabled={isSubmitting}
              style={{...styles.input, opacity: isSubmitting ? 0.6 : 1}}
              placeholder="Enter at least 6 characters"
            />
          </div>

          <button type="submit" style={dynamicStyles.button} disabled={isSubmitting}>
            {isSubmitting ? "Activating..." : "Set Password & Login"}
          </button>
        </Form>
      </div>
    </div>
  );
}

const styles = {
  container: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "linear-gradient(135deg, #fdf4f7 0%, #fff7eb 100%)",
    fontFamily: "'Inter', sans-serif",
    padding: "20px",
  },
  card: {
    background: "rgba(255, 255, 255, 0.9)",
    backdropFilter: "blur(10px)",
    borderRadius: "24px",
    padding: "48px",
    width: "100%",
    maxWidth: "480px",
    boxShadow: "0 20px 40px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.05)",
    border: "1px solid rgba(255,255,255,0.5)",
  },
  header: {
    marginBottom: "32px",
    textAlign: "center" as const,
  },
  heroText: {
    fontFamily: "'Poppins', sans-serif",
    fontSize: "36px",
    fontWeight: 700,
    margin: "0 0 16px 0",
    lineHeight: 1.2,
    letterSpacing: "-0.01em",
    background: "linear-gradient(135deg, #E91E63 0%, #FF6B35 100%)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
  },
  bodyText: {
    fontSize: "16px",
    color: "#4a4a4a",
    lineHeight: 1.6,
    margin: 0,
  },
  form: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "24px",
  },
  inputGroup: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "8px",
  },
  label: {
    fontSize: "14px",
    fontWeight: 500,
    color: "#333",
  },
  input: {
    padding: "16px",
    borderRadius: "12px",
    border: "1px solid #e1e1e1",
    fontSize: "16px",
    fontFamily: "'Inter', sans-serif",
    transition: "border-color 0.2s, box-shadow 0.2s",
    outline: "none",
  },
  button: {
    marginTop: "8px",
    padding: "16px 24px",
    borderRadius: "12px",
    border: "none",
    background: "linear-gradient(135deg, var(--sales-portal-accent) 0%, var(--sales-portal-accent-dark) 100%)",
    color: "var(--sales-portal-accent-contrast)",
    fontSize: "18px",
    fontWeight: 600,
    fontFamily: "'Poppins', sans-serif",
    cursor: "pointer",
    transition: "transform 0.2s, box-shadow 0.2s",
    boxShadow: "0 4px 12px var(--sales-portal-focus-ring)",
  },
  errorAlert: {
    background: "#fee2e2",
    color: "#991b1b",
    padding: "16px",
    borderRadius: "12px",
    marginBottom: "24px",
    fontSize: "14px",
    fontWeight: 500,
  },
};
