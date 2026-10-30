export function createRequireSupabaseAuth(supabase) {
  return async function requireSupabaseAuth(req, res, next) {
    const match = (req.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return res
        .status(401)
        .json({ success: false, message: "Authentication required." });
    }

    try {
      const {
        data: { user },
        error,
      } = await supabase.auth.getUser(match[1]);

      if (error) {
        const status = error.status === 401 || error.status === 403 ? 401 : 503;
        if (status === 503) {
          console.error("[TTS authentication unavailable]:", error.message);
        }
        return res.status(status).json({
          success: false,
          message:
            status === 401
              ? "Invalid or expired session."
              : "Unable to verify the current session.",
        });
      }

      if (!user) {
        return res
          .status(401)
          .json({ success: false, message: "Invalid or expired session." });
      }

      req.authUser = user;
      return next();
    } catch (error) {
      console.error("[TTS authentication failed]:", error.message);
      return res.status(503).json({
        success: false,
        message: "Unable to verify the current session.",
      });
    }
  };
}
