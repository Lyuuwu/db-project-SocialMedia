USE test

drop table if exists comment
drop table if exists follow
drop table if exists likes
drop table if exists post
drop table if exists users

create table users(
	user_id			int identity(1, 1) not null ,
	Email			varchar(255) not null,
	pwd				varchar(255) not null,
	bio				nvarchar(1024) null,
	profile_pic		nvarchar(1024) null,
	user_name		nvarchar(50) not null,

	constraint PK_users primary key (user_id),
	constraint UQ_users_email unique (Email),
);

create table post(
	post_id		int identity(1,1) not null,
	user_id		int not null,
	picture		nvarchar(1024) null,
	content		nvarchar(2048) not null,
	created_at datetime2(0) not null constraint DF_post_created_time default (sysdatetime()),
	likes		int not null constraint DF_likes_num default 0,

	constraint PK_post primary key (post_id),
	constraint FK_post foreign key (user_id) references users(user_id) on delete cascade
);

create table likes(
	post_id		int not null,
	user_id		int not null,

	constraint PK_likes primary key(post_id, user_id),
	constraint FK_likes_post foreign key (post_id) references post(post_id) on delete cascade,
	constraint FK_likes_user foreign key (user_id) references users(user_id) on delete no action
);

create table follow(
	follower_id		int not null,
	followee_id		int not null,

	constraint PK_follow primary key (follower_id, followee_id),
	constraint FK_follower_id foreign key (follower_id) references users(user_id) on delete no action,
	constraint FK_followee_id foreign key (followee_id) references users(user_id) on delete no action,
	constraint CK_follow_not_self check (follower_id <> followee_id)
);

create table comment(
	user_id		int not null,
	comment_id	int identity(1, 1) not null,
	post_id		int not null,
	content		nvarchar(1024),
	created_at datetime2(0) not null constraint DF_comment_time default (sysdatetime()),
	update_at  datetime2(0) null,

	constraint PK_comment primary key (comment_id),
	constraint FK_comment_user foreign key (user_id) references users(user_id) on delete no action,
	constraint FK_comment_post foreign key (post_id) references post(post_id) on delete cascade
);