<?php
/**
 * Settings screen.
 *
 * @package Local_Business_Schema_Hours
 */

defined( 'ABSPATH' ) || exit;

/**
 * Renders and persists the location settings.
 */
class LBSH_Admin {

	const PAGE  = 'lbsh-settings';
	const NONCE = 'lbsh_save_locations';

	/**
	 * Hook into WordPress.
	 *
	 * @return void
	 */
	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'add_page' ) );
		add_action( 'admin_post_lbsh_save', array( __CLASS__, 'handle_save' ) );
		add_filter( 'plugin_action_links_' . LBSH_BASENAME, array( __CLASS__, 'action_links' ) );
	}

	/**
	 * Add the settings page under Settings.
	 *
	 * @return void
	 */
	public static function add_page() {
		add_options_page(
			__( 'Business Hours & Schema', 'local-business-schema-hours' ),
			__( 'Business Hours', 'local-business-schema-hours' ),
			'manage_options',
			self::PAGE,
			array( __CLASS__, 'render' )
		);
	}

	/**
	 * Add a settings shortcut to the plugin list.
	 *
	 * @param array $links Existing links.
	 * @return array
	 */
	public static function action_links( $links ) {
		array_unshift(
			$links,
			sprintf(
				'<a href="%s">%s</a>',
				esc_url( admin_url( 'options-general.php?page=' . self::PAGE ) ),
				esc_html__( 'Settings', 'local-business-schema-hours' )
			)
		);

		return $links;
	}

	/**
	 * Validate and persist submitted locations.
	 *
	 * @return void
	 */
	public static function handle_save() {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You are not allowed to change these settings.', 'local-business-schema-hours' ) );
		}

		check_admin_referer( self::NONCE );

		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- verified by check_admin_referer above.
		$raw = isset( $_POST['lbsh'] ) ? wp_unslash( $_POST['lbsh'] ) : array();

		LBSH_Locations::save( LBSH_Locations::sanitize_all( $raw ) );

		wp_safe_redirect(
			add_query_arg(
				array(
					'page'    => self::PAGE,
					'updated' => 'true',
				),
				admin_url( 'options-general.php' )
			)
		);

		exit;
	}

	/**
	 * Render the settings screen.
	 *
	 * @return void
	 */
	public static function render() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}

		$locations = LBSH_Locations::get_all_raw();

		if ( empty( $locations ) ) {
			$locations = array( LBSH_Locations::blank() );
		}

		$is_pro = LBSH_License::is_pro();
		$limit  = LBSH_License::location_limit();

		if ( PHP_INT_MAX !== $limit && count( $locations ) > $limit ) {
			$locations = array_slice( $locations, 0, $limit );
		}

		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'Business Hours &amp; Schema', 'local-business-schema-hours' ); ?></h1>

			<?php if ( isset( $_GET['updated'] ) ) : // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- read-only notice flag. ?>
				<div class="notice notice-success is-dismissible">
					<p><?php esc_html_e( 'Settings saved.', 'local-business-schema-hours' ); ?></p>
				</div>
			<?php endif; ?>

			<p>
				<?php esc_html_e( 'These details are published as LocalBusiness structured data so search engines can show your hours, address and "open now" state.', 'local-business-schema-hours' ); ?>
			</p>

			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<input type="hidden" name="action" value="lbsh_save" />
				<?php wp_nonce_field( self::NONCE ); ?>

				<?php foreach ( $locations as $index => $location ) : ?>
					<?php self::render_location( $index, wp_parse_args( $location, LBSH_Locations::blank() ), $is_pro ); ?>
				<?php endforeach; ?>

				<?php if ( ! $is_pro ) : ?>
					<div class="notice notice-info inline" style="margin:20px 0;padding:12px;">
						<p style="margin:0 0 6px;">
							<strong><?php esc_html_e( 'More than one location?', 'local-business-schema-hours' ); ?></strong>
						</p>
						<p style="margin:0;">
							<?php esc_html_e( 'Additional locations, holiday and seasonal closing dates, per-location time zones and the store locator are part of the premium edition.', 'local-business-schema-hours' ); ?>
						</p>
					</div>
				<?php endif; ?>

				<?php submit_button(); ?>
			</form>

			<h2><?php esc_html_e( 'Displaying hours', 'local-business-schema-hours' ); ?></h2>
			<p><?php esc_html_e( 'Use these shortcodes, or the matching blocks in the editor:', 'local-business-schema-hours' ); ?></p>
			<ul>
				<li><code>[business_hours]</code> &mdash; <?php esc_html_e( 'the weekly opening hours table.', 'local-business-schema-hours' ); ?></li>
				<li><code>[business_status]</code> &mdash; <?php esc_html_e( 'an open/closed badge with the next opening or closing time.', 'local-business-schema-hours' ); ?></li>
				<li><code>[business_open]&hellip;[/business_open]</code> &mdash; <?php esc_html_e( 'content shown only while open.', 'local-business-schema-hours' ); ?></li>
				<li><code>[business_closed]&hellip;[/business_closed]</code> &mdash; <?php esc_html_e( 'content shown only while closed.', 'local-business-schema-hours' ); ?></li>
			</ul>
		</div>
		<?php
	}

	/**
	 * Render one location fieldset.
	 *
	 * @param int   $index    Position in the list.
	 * @param array $location Location data.
	 * @param bool  $is_pro   Whether premium features are unlocked.
	 * @return void
	 */
	private static function render_location( $index, array $location, $is_pro ) {
		$name = 'lbsh[' . (int) $index . ']';

		$fields = array(
			'name'        => __( 'Business name', 'local-business-schema-hours' ),
			'telephone'   => __( 'Phone', 'local-business-schema-hours' ),
			'email'       => __( 'Email', 'local-business-schema-hours' ),
			'url'         => __( 'Website URL', 'local-business-schema-hours' ),
			'street'      => __( 'Street address', 'local-business-schema-hours' ),
			'city'        => __( 'City', 'local-business-schema-hours' ),
			'region'      => __( 'Region or state', 'local-business-schema-hours' ),
			'postcode'    => __( 'Postal code', 'local-business-schema-hours' ),
			'country'     => __( 'Country code', 'local-business-schema-hours' ),
			'latitude'    => __( 'Latitude', 'local-business-schema-hours' ),
			'longitude'   => __( 'Longitude', 'local-business-schema-hours' ),
			'price_range' => __( 'Price range', 'local-business-schema-hours' ),
			'image'       => __( 'Photo URL', 'local-business-schema-hours' ),
		);

		?>
		<h2><?php echo esc_html( $location['name'] ? $location['name'] : __( 'Location', 'local-business-schema-hours' ) ); ?></h2>
		<input type="hidden" name="<?php echo esc_attr( $name . '[id]' ); ?>" value="<?php echo esc_attr( $location['id'] ); ?>" />

		<table class="form-table" role="presentation">
			<tr>
				<th scope="row"><label for="lbsh-type-<?php echo esc_attr( $index ); ?>"><?php esc_html_e( 'Business type', 'local-business-schema-hours' ); ?></label></th>
				<td>
					<select id="lbsh-type-<?php echo esc_attr( $index ); ?>" name="<?php echo esc_attr( $name . '[type]' ); ?>">
						<?php foreach ( LBSH_Schema::types() as $slug => $label ) : ?>
							<option value="<?php echo esc_attr( $slug ); ?>" <?php selected( $location['type'], $slug ); ?>>
								<?php echo esc_html( $label ); ?>
							</option>
						<?php endforeach; ?>
					</select>
					<p class="description"><?php esc_html_e( 'Pick the closest match. This becomes the schema.org type.', 'local-business-schema-hours' ); ?></p>
				</td>
			</tr>

			<?php foreach ( $fields as $field => $label ) : ?>
				<tr>
					<th scope="row">
						<label for="lbsh-<?php echo esc_attr( $field . '-' . $index ); ?>"><?php echo esc_html( $label ); ?></label>
					</th>
					<td>
						<input
							type="text"
							class="regular-text"
							id="lbsh-<?php echo esc_attr( $field . '-' . $index ); ?>"
							name="<?php echo esc_attr( $name . '[' . $field . ']' ); ?>"
							value="<?php echo esc_attr( $location[ $field ] ); ?>" />
					</td>
				</tr>
			<?php endforeach; ?>

			<tr>
				<th scope="row"><label for="lbsh-tz-<?php echo esc_attr( $index ); ?>"><?php esc_html_e( 'Time zone', 'local-business-schema-hours' ); ?></label></th>
				<td>
					<?php if ( $is_pro ) : ?>
						<select id="lbsh-tz-<?php echo esc_attr( $index ); ?>" name="<?php echo esc_attr( $name . '[timezone]' ); ?>">
							<?php foreach ( timezone_identifiers_list() as $tz ) : ?>
								<option value="<?php echo esc_attr( $tz ); ?>" <?php selected( $location['timezone'], $tz ); ?>><?php echo esc_html( $tz ); ?></option>
							<?php endforeach; ?>
						</select>
					<?php else : ?>
						<input type="hidden" name="<?php echo esc_attr( $name . '[timezone]' ); ?>" value="<?php echo esc_attr( wp_timezone_string() ); ?>" />
						<code><?php echo esc_html( wp_timezone_string() ); ?></code>
						<p class="description"><?php esc_html_e( 'Uses the site time zone from Settings &rarr; General.', 'local-business-schema-hours' ); ?></p>
					<?php endif; ?>
				</td>
			</tr>

			<tr>
				<th scope="row"><label for="lbsh-desc-<?php echo esc_attr( $index ); ?>"><?php esc_html_e( 'Short description', 'local-business-schema-hours' ); ?></label></th>
				<td>
					<textarea class="large-text" rows="2" id="lbsh-desc-<?php echo esc_attr( $index ); ?>" name="<?php echo esc_attr( $name . '[description]' ); ?>"><?php echo esc_textarea( $location['description'] ); ?></textarea>
				</td>
			</tr>

			<tr>
				<th scope="row"><label for="lbsh-sameas-<?php echo esc_attr( $index ); ?>"><?php esc_html_e( 'Profile links', 'local-business-schema-hours' ); ?></label></th>
				<td>
					<textarea class="large-text" rows="3" id="lbsh-sameas-<?php echo esc_attr( $index ); ?>" name="<?php echo esc_attr( $name . '[sameas]' ); ?>"><?php echo esc_textarea( $location['sameas'] ); ?></textarea>
					<p class="description"><?php esc_html_e( 'One URL per line: Google Business Profile, Facebook, Instagram, Yelp.', 'local-business-schema-hours' ); ?></p>
				</td>
			</tr>
		</table>

		<h3><?php esc_html_e( 'Opening hours', 'local-business-schema-hours' ); ?></h3>
		<p class="description"><?php esc_html_e( 'Leave both boxes empty to mark a day closed. A closing time earlier than the opening time runs past midnight.', 'local-business-schema-hours' ); ?></p>

		<table class="form-table" role="presentation">
			<?php
			$labels = array(
				'mon' => __( 'Monday', 'local-business-schema-hours' ),
				'tue' => __( 'Tuesday', 'local-business-schema-hours' ),
				'wed' => __( 'Wednesday', 'local-business-schema-hours' ),
				'thu' => __( 'Thursday', 'local-business-schema-hours' ),
				'fri' => __( 'Friday', 'local-business-schema-hours' ),
				'sat' => __( 'Saturday', 'local-business-schema-hours' ),
				'sun' => __( 'Sunday', 'local-business-schema-hours' ),
			);

			foreach ( LBSH_Schedule::DAYS as $day ) :
				$periods = isset( $location['weekly'][ $day ] ) ? array_values( (array) $location['weekly'][ $day ] ) : array();
				?>
				<tr>
					<th scope="row"><?php echo esc_html( $labels[ $day ] ); ?></th>
					<td>
						<?php for ( $slot = 0; $slot < 2; $slot++ ) : ?>
							<?php
							$open  = isset( $periods[ $slot ]['open'] ) ? $periods[ $slot ]['open'] : '';
							$close = isset( $periods[ $slot ]['close'] ) ? $periods[ $slot ]['close'] : '';
							$base  = $name . '[weekly][' . $day . '][' . $slot . ']';
							?>
							<label class="screen-reader-text" for="<?php echo esc_attr( 'lbsh-' . $day . '-' . $slot . '-open-' . $index ); ?>">
								<?php echo esc_html( $labels[ $day ] ); ?>
							</label>
							<input
								type="time"
								id="<?php echo esc_attr( 'lbsh-' . $day . '-' . $slot . '-open-' . $index ); ?>"
								name="<?php echo esc_attr( $base . '[open]' ); ?>"
								value="<?php echo esc_attr( $open ); ?>" />
							&ndash;
							<input
								type="time"
								name="<?php echo esc_attr( $base . '[close]' ); ?>"
								value="<?php echo esc_attr( $close ); ?>"
								aria-label="<?php echo esc_attr( $labels[ $day ] ); ?>" />
							<?php echo 0 === $slot ? '&nbsp;&nbsp;' : ''; ?>
						<?php endfor; ?>
					</td>
				</tr>
			<?php endforeach; ?>
		</table>

		<h3><?php esc_html_e( 'Holidays and closures', 'local-business-schema-hours' ); ?></h3>

		<?php if ( ! $is_pro ) : ?>
			<p class="description">
				<?php esc_html_e( 'Holiday and seasonal dates are part of the premium edition. Your regular weekly hours keep working as normal.', 'local-business-schema-hours' ); ?>
			</p>
		<?php else : ?>
			<p class="description">
				<?php esc_html_e( 'Use YYYY-MM-DD for a one-off date, or MM-DD for a date that repeats every year. Leave the times empty to close for the whole day.', 'local-business-schema-hours' ); ?>
			</p>
			<table class="form-table" role="presentation">
				<?php
				$exceptions = (array) $location['exceptions'];
				$rows       = array();

				foreach ( $exceptions as $date => $periods ) {
					$periods = array_values( (array) $periods );
					$rows[]  = array(
						'date'  => $date,
						'open'  => isset( $periods[0]['open'] ) ? $periods[0]['open'] : '',
						'close' => isset( $periods[0]['close'] ) ? $periods[0]['close'] : '',
					);
				}

				// Always offer three spare rows.
				for ( $i = 0; $i < 3; $i++ ) {
					$rows[] = array(
						'date'  => '',
						'open'  => '',
						'close' => '',
					);
				}

				foreach ( $rows as $slot => $row ) :
					$base = $name . '[exceptions][' . (int) $slot . ']';
					?>
					<tr>
						<th scope="row">
							<label for="<?php echo esc_attr( 'lbsh-ex-' . $index . '-' . $slot ); ?>"><?php esc_html_e( 'Date', 'local-business-schema-hours' ); ?></label>
						</th>
						<td>
							<input
								type="text"
								id="<?php echo esc_attr( 'lbsh-ex-' . $index . '-' . $slot ); ?>"
								name="<?php echo esc_attr( $base . '[date]' ); ?>"
								value="<?php echo esc_attr( $row['date'] ); ?>"
								placeholder="2026-12-25"
								class="regular-text" />
							<input type="time" name="<?php echo esc_attr( $base . '[open]' ); ?>" value="<?php echo esc_attr( $row['open'] ); ?>" aria-label="<?php esc_attr_e( 'Opening time', 'local-business-schema-hours' ); ?>" />
							&ndash;
							<input type="time" name="<?php echo esc_attr( $base . '[close]' ); ?>" value="<?php echo esc_attr( $row['close'] ); ?>" aria-label="<?php esc_attr_e( 'Closing time', 'local-business-schema-hours' ); ?>" />
						</td>
					</tr>
				<?php endforeach; ?>
			</table>
		<?php endif; ?>
		<?php
	}
}
