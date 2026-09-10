<?php
/**
 * Plugin Name:       Local Business Schema & Hours
 * Plugin URI:        https://github.com/GrantasA/wildflour-bakery
 * Description:       Publish valid LocalBusiness structured data with your opening hours, and show an accurate "open now" badge, hours table and holiday closures on the front end.
 * Version:           1.0.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            Wildflour
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       local-business-schema-hours
 * Domain Path:       /languages
 *
 * @package Local_Business_Schema_Hours
 */

defined( 'ABSPATH' ) || exit;

define( 'LBSH_VERSION', '1.0.0' );
define( 'LBSH_FILE', __FILE__ );
define( 'LBSH_DIR', plugin_dir_path( __FILE__ ) );
define( 'LBSH_URL', plugin_dir_url( __FILE__ ) );
define( 'LBSH_BASENAME', plugin_basename( __FILE__ ) );

require_once LBSH_DIR . 'includes/class-lbsh-schedule.php';
require_once LBSH_DIR . 'includes/class-lbsh-schema.php';
require_once LBSH_DIR . 'includes/class-lbsh-license.php';
require_once LBSH_DIR . 'includes/class-lbsh-locations.php';
require_once LBSH_DIR . 'includes/class-lbsh-frontend.php';
require_once LBSH_DIR . 'includes/class-lbsh-rest.php';

if ( is_admin() ) {
	require_once LBSH_DIR . 'includes/class-lbsh-admin.php';
}

/**
 * Load premium code when this build contains it.
 *
 * The edition published on WordPress.org has includes/pro removed at build
 * time, so this is a no-op there.
 *
 * @return void
 */
function lbsh_load_premium() {
	if ( ! LBSH_License::has_premium_build() ) {
		return;
	}

	$bootstrap = LBSH_DIR . 'includes/pro/bootstrap.php';

	if ( file_exists( $bootstrap ) ) {
		require_once $bootstrap;
	}
}

/**
 * Boot the plugin.
 *
 * @return void
 */
function lbsh_bootstrap() {
	lbsh_load_premium();

	LBSH_Frontend::init();
	LBSH_Rest::init();

	if ( is_admin() ) {
		LBSH_Admin::init();
	}
}

add_action( 'plugins_loaded', 'lbsh_bootstrap' );

/**
 * Seed a first location from the site's own details on activation.
 *
 * Starting from real values means the plugin emits useful markup immediately
 * rather than an empty shell.
 *
 * @return void
 */
function lbsh_activate() {
	if ( ! empty( get_option( LBSH_Locations::OPTION, array() ) ) ) {
		return;
	}

	$location       = LBSH_Locations::blank();
	$location['id'] = '1';

	LBSH_Locations::save( array( $location ) );
}

register_activation_hook( __FILE__, 'lbsh_activate' );
