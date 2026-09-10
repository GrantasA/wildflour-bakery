<?php
/**
 * Removes plugin data when the plugin is deleted.
 *
 * @package Local_Business_Schema_Hours
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

delete_option( 'lbsh_locations' );

// Multisite installs keep the option per site.
if ( is_multisite() ) {
	$site_ids = get_sites(
		array(
			'fields' => 'ids',
			'number' => 0,
		)
	);

	foreach ( $site_ids as $site_id ) {
		switch_to_blog( $site_id );
		delete_option( 'lbsh_locations' );
		restore_current_blog();
	}
}
