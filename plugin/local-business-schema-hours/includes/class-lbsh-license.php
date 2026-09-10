<?php
/**
 * Single gate for premium capability checks.
 *
 * @package Local_Business_Schema_Hours
 */

defined( 'ABSPATH' ) || exit;

/**
 * Answers "may this site use premium features?".
 *
 * All premium checks funnel through here so the billing provider can be
 * swapped without touching feature code. When the Freemius SDK is present its
 * verdict is authoritative; otherwise the plugin behaves as the free edition.
 */
class LBSH_License {

	/**
	 * Cached verdict for the current request.
	 *
	 * @var bool|null
	 */
	private static $is_pro = null;

	/**
	 * Whether premium features are unlocked.
	 *
	 * @return bool
	 */
	public static function is_pro() {
		if ( null !== self::$is_pro ) {
			return self::$is_pro;
		}

		$is_pro = false;

		// Freemius, when the premium build is installed and a licence is active.
		if ( function_exists( 'lbsh_fs' ) ) {
			$fs = lbsh_fs();

			if ( is_object( $fs ) && method_exists( $fs, 'can_use_premium_code__premium_only' ) ) {
				$is_pro = (bool) $fs->can_use_premium_code__premium_only();
			} elseif ( is_object( $fs ) && method_exists( $fs, 'is_paying' ) ) {
				$is_pro = (bool) $fs->is_paying();
			}
		}

		/**
		 * Filters whether premium features are available.
		 *
		 * Exposed so site owners running the premium build behind their own
		 * licensing, and automated tests, can override the verdict.
		 *
		 * @param bool $is_pro Whether premium features are unlocked.
		 */
		self::$is_pro = (bool) apply_filters( 'lbsh_is_pro', $is_pro );

		return self::$is_pro;
	}

	/**
	 * Whether the premium source tree shipped with this build.
	 *
	 * The free edition distributed on WordPress.org has this directory removed
	 * at build time, so premium code is never shipped to free users.
	 *
	 * @return bool
	 */
	public static function has_premium_build() {
		return is_dir( LBSH_DIR . 'includes/pro' );
	}

	/**
	 * Maximum number of locations this site may configure.
	 *
	 * @return int PHP_INT_MAX when unlimited.
	 */
	public static function location_limit() {
		return self::is_pro() ? PHP_INT_MAX : 1;
	}

	/**
	 * Reset the cached verdict. Intended for tests.
	 *
	 * @return void
	 */
	public static function flush() {
		self::$is_pro = null;
	}
}
