import { LoaderFunctionArgs, ActionFunctionArgs, redirect } from "react-router";
import { Form, useLoaderData, useActionData, useNavigation } from "react-router";
import prisma from "app/db.server";
import { createSalesSession, buildSessionCookie } from "app/utils/sales-session.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const storeid = url.searchParams.get("storeid");
  const userid = url.searchParams.get("userid");
  const token = url.searchParams.get("token");

  if (!storeid || !userid || !token) {
    return Response.json({ valid: false, message: "Invalid invitation link." });
  }

  const invitation = await prisma.invitation.findUnique({
    where: { token, userId: userid, shopId: storeid },
    include: { user: true },
  });

  if (!invitation) {
    return Response.json({ valid: false, message: "Invitation not found." });
  }

  if (!invitation.isActive) {
    return Response.json({ valid: false, message: "Invitation is no longer active." });
  }

  if (new Date() > new Date(invitation.expiresAt)) {
    return Response.json({ valid: false, message: "Invitation has expired." });
  }

  return Response.json({
    valid: true,
    user: {
      email: invitation.user.email,
      firstName: invitation.user.firstName,
      lastName: invitation.user.lastName,
    },
    storeid,
    userid,
    token,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const password = formData.get("password") as string;
  const storeid = formData.get("storeid") as string;
  const userid = formData.get("userid") as string;
  const token = formData.get("token") as string;

  if (!password || password.length < 6) {
    return Response.json({ error: "Password must be at least 6 characters." });
  }

  const invitation = await prisma.invitation.findUnique({
    where: { token, userId: userid, shopId: storeid },
  });

  if (!invitation || !invitation.isActive || new Date() > new Date(invitation.expiresAt)) {
    return Response.json({ error: "Invalid or expired invitation." });
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

  // Create a cookie-based session and redirect to the unified Sales Portal
  const sessionToken = await createSalesSession(userid);

  return redirect("/sales/dashboard", {
    headers: {
      "Set-Cookie": buildSessionCookie(sessionToken),
    },
  });
};

export default function SupportLogin() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  if (!loaderData.valid) {
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <h1 style={styles.heroText}>Link Expired</h1>
          <p style={styles.bodyText}>{loaderData.message}</p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <div style={styles.header}>
          <h1 style={styles.heroText}>Welcome, {loaderData.user.firstName}!</h1>
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
          <input type="hidden" name="storeid" value={loaderData.storeid} />
          <input type="hidden" name="userid" value={loaderData.userid} />
          <input type="hidden" name="token" value={loaderData.token} />

          <div style={styles.inputGroup}>
            <label style={styles.label}>Email Address</label>
            <input
              type="email"
              value={loaderData.user.email}
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
              style={styles.input}
              placeholder="Enter at least 6 characters"
            />
          </div>

          <button type="submit" style={styles.button} disabled={isSubmitting}>
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
    background: "linear-gradient(135deg, #E91E63 0%, #FF6B35 100%)",
    color: "white",
    fontSize: "18px",
    fontWeight: 600,
    fontFamily: "'Poppins', sans-serif",
    cursor: "pointer",
    transition: "transform 0.2s, box-shadow 0.2s",
    boxShadow: "0 4px 12px rgba(233, 30, 99, 0.3)",
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
